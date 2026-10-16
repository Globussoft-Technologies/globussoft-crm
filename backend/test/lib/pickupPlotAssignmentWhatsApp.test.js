import { beforeEach, describe, expect, test, vi } from 'vitest';
import prisma from '../../lib/prisma.js';

for (const modelName of ['tenant', 'whatsAppConfig', 'contact', 'customerPickup', 'plotSite', 'transportPerson', 'whatsAppThread', 'whatsAppMessage']) {
  if (!prisma[modelName]) prisma[modelName] = {};
}

prisma.tenant.findUnique = vi.fn();
prisma.whatsAppConfig.findFirst = vi.fn();
prisma.contact.findMany = vi.fn();
prisma.customerPickup.findMany = vi.fn();
prisma.plotSite.findMany = vi.fn();
prisma.transportPerson.findMany = vi.fn();
prisma.whatsAppThread.upsert = vi.fn();
prisma.whatsAppThread.findMany = vi.fn();
prisma.whatsAppThread.deleteMany = vi.fn();
prisma.whatsAppThread.update = vi.fn();
prisma.whatsAppMessage.findFirst = vi.fn();
prisma.whatsAppMessage.updateMany = vi.fn();
prisma.whatsAppMessage.create = vi.fn();

const queue = require('../../lib/whatsappQueue');
const enqueueSend = vi.fn();
vi.spyOn(queue, 'getQueue').mockReturnValue({ enqueueSend });

const { notifyCustomerPickupPlotAssignments } = require('../../lib/pickupPlotAssignmentWhatsApp');

const person = { id: 41, assignmentPairsJson: '[{"customerId":21,"plotSiteId":30}]' };

beforeEach(() => {
  vi.clearAllMocks();
  prisma.tenant.findUnique.mockResolvedValue({ vertical: 'generic' });
  prisma.whatsAppConfig.findFirst.mockResolvedValue({ phoneNumberId: 'sender-1' });
  prisma.contact.findMany.mockResolvedValue([{ id: 21, name: 'Priya Shah', phone: '9876543210', whatsappPhone: null }]);
  prisma.customerPickup.findMany.mockResolvedValue([{ contactId: 21, pickupAddress: '42 Lake View Road' }]);
  prisma.plotSite.findMany.mockResolvedValue([{ id: 30, name: 'Green Acres', plotNumber: 'A-30', address: 'Airport Road' }]);
  prisma.transportPerson.findMany.mockResolvedValue([person]);
  prisma.whatsAppThread.upsert.mockResolvedValue({ id: 51, contactPhone: '+919876543210', unreadCount: 0 });
  prisma.whatsAppThread.findMany.mockResolvedValue([]);
  prisma.whatsAppMessage.findFirst.mockResolvedValue(null);
  prisma.whatsAppMessage.create.mockResolvedValue({ id: 61 });
  enqueueSend.mockResolvedValue({ jobId: 71 });
});

describe('customer pickup/plot WhatsApp notification', () => {
  test('queues pickup and assigned-plot details in the customer WhatsApp thread', async () => {
    const result = await notifyCustomerPickupPlotAssignments({ tenantId: 7, person });

    expect(result).toEqual({ sent: 1 });
    expect(prisma.whatsAppThread.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { tenantId_contactPhone: { tenantId: 7, contactPhone: '+919876543210' } },
    }));
    expect(prisma.whatsAppMessage.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        to: '919876543210', contactId: 21, threadId: 51, status: 'QUEUED',
        body: expect.stringContaining('Pickup: 42 Lake View Road'),
      }),
    });
    expect(prisma.whatsAppMessage.create.mock.calls[0][0].data.body).toContain('Assigned plot: Green Acres (A-30) - Airport Road');
    expect(enqueueSend).toHaveBeenCalledWith({ messageId: 61, tenantId: 7 });
  });

  test('sends when pickup is saved after the plot assignment', async () => {
    await expect(notifyCustomerPickupPlotAssignments({ tenantId: 7, contactId: 21 }))
      .resolves.toEqual({ sent: 1 });
    expect(prisma.transportPerson.findMany).toHaveBeenCalledWith({
      where: { tenantId: 7, isActive: true },
      select: { customerIdsJson: true, plotSiteIdsJson: true, assignmentPairsJson: true },
    });
  });

  test('does not send until the customer has a pickup address', async () => {
    prisma.customerPickup.findMany.mockResolvedValue([]);
    await expect(notifyCustomerPickupPlotAssignments({ tenantId: 7, person })).resolves.toEqual({ sent: 0 });
    expect(prisma.whatsAppMessage.create).not.toHaveBeenCalled();
  });

  test('does not resend an unchanged assignment', async () => {
    await expect(notifyCustomerPickupPlotAssignments({ tenantId: 7, person, previousPerson: person }))
      .resolves.toEqual({ sent: 0, code: 'NO_NEW_ASSIGNMENTS' });
    expect(prisma.whatsAppMessage.create).not.toHaveBeenCalled();
  });

  test('does not affect non-generic tenants', async () => {
    prisma.tenant.findUnique.mockResolvedValue({ vertical: 'wellness' });
    await expect(notifyCustomerPickupPlotAssignments({ tenantId: 7, person }))
      .resolves.toEqual({ sent: 0, code: 'GENERIC_ONLY' });
    expect(prisma.whatsAppMessage.create).not.toHaveBeenCalled();
  });
});
