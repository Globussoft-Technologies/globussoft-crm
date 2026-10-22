import { beforeEach, describe, expect, test, vi } from 'vitest';
import prisma from '../../lib/prisma.js';
import { hydrateGenericEventPayload, matchesEventConditions, processContactCreated, processGenericChannelCampaignEvent, processWhatsAppCampaignEvent, templateParameterValues } from '../../lib/genericCampaignAutomation.js';

vi.mock('../../lib/whatsappQueue.js', () => ({
  getQueue: () => ({ enqueueSend: vi.fn().mockResolvedValue({}) }),
}));

beforeEach(() => {
  prisma.tenant = { findUnique: vi.fn().mockResolvedValue({ vertical: 'generic' }) };
  prisma.contact = { findFirst: vi.fn().mockResolvedValue({ id: 7, status: 'Lead', email: 'lead@example.com', phone: '9876543210' }) };
  prisma.leadCustomFieldValue = { findMany: vi.fn().mockResolvedValue([]) };
  prisma.campaign = { findMany: vi.fn() };
  prisma.sequenceEnrollment = {
    findFirst: vi.fn().mockResolvedValue(null),
    create: vi.fn().mockResolvedValue({ id: 42 }),
  };
});

describe('Generic Email/SMS trigger sequences', () => {
  test('enrolls a matching email template sequence once for a new lead', async () => {
    const campaign = {
      id: 22,
      channel: 'EMAIL',
      sequence: { id: 90, isActive: true, steps: [{ kind: 'email', emailTemplateId: 9 }] },
      scheduleFilters: JSON.stringify({ automationType: 'generic_channel_event', channel: 'EMAIL', triggerEvent: 'contact.created', templateId: 9 }),
    };
    prisma.campaign.findMany.mockResolvedValue([campaign]);

    expect(await processGenericChannelCampaignEvent('contact.created', { contactId: 7 }, 1)).toEqual({ enrolled: 1 });
    expect(prisma.sequenceEnrollment.create).toHaveBeenCalledWith({ data: expect.objectContaining({
      sequenceId: 90,
      contactId: 7,
      currentNode: 'campaign-event:22:contact.created:7',
      currentStep: 0,
      status: 'Active',
      tenantId: 1,
    }) });
    prisma.sequenceEnrollment.findFirst.mockResolvedValue({ id: 500 });
    expect(await processGenericChannelCampaignEvent('contact.created', { contactId: 7 }, 1)).toEqual({ enrolled: 0 });
  });

  test('enrolls SMS steps for successful payment events and ignores other verticals', async () => {
    prisma.payment = { findFirst: vi.fn().mockResolvedValue({ id: 81, status: 'SUCCESS', contactId: 7 }) };
    prisma.campaign.findMany.mockResolvedValue([{
      id: 23,
      channel: 'SMS',
      sequence: { id: 91, isActive: true, steps: [{ kind: 'sms', smsBody: 'Thanks' }] },
      scheduleFilters: JSON.stringify({ automationType: 'generic_channel_event', channel: 'SMS', triggerEvent: 'payment.collected', templateId: 12 }),
    }]);
    expect(await processGenericChannelCampaignEvent('payment.collected', { paymentId: 81, contactId: 7, payment: { status: 'SUCCESS' } }, 1)).toEqual({ enrolled: 1 });
    prisma.tenant.findUnique.mockResolvedValue({ vertical: 'wellness' });
    expect(await processGenericChannelCampaignEvent('payment.collected', { paymentId: 81 }, 1)).toMatchObject({ skipped: 'non_generic' });
  });

  test('enrolls repeated lead updates separately when each event has a unique id', async () => {
    prisma.campaign.findMany.mockResolvedValue([{
      id: 24,
      channel: 'EMAIL',
      sequence: { id: 92, isActive: true, steps: [{ kind: 'email', emailTemplateId: 13 }] },
      scheduleFilters: JSON.stringify({ automationType: 'generic_channel_event', channel: 'EMAIL', triggerEvent: 'contact.updated', templateId: 13 }),
    }]);

    await processGenericChannelCampaignEvent('contact.updated', { contactId: 7, eventId: '7-update-1' }, 1);
    await processGenericChannelCampaignEvent('contact.updated', { contactId: 7, eventId: '7-update-2' }, 1);

    expect(prisma.sequenceEnrollment.create).toHaveBeenNthCalledWith(1, { data: expect.objectContaining({ currentNode: 'campaign-event:24:contact.updated:7-update-1' }) });
    expect(prisma.sequenceEnrollment.create).toHaveBeenNthCalledWith(2, { data: expect.objectContaining({ currentNode: 'campaign-event:24:contact.updated:7-update-2' }) });
  });

  test('enrolls a status-change preset whose first sequence step is a CRM condition', async () => {
    prisma.campaign.findMany.mockResolvedValue([{
      id: 26,
      channel: 'EMAIL',
      sequence: { id: 94, isActive: true, steps: [{ kind: 'condition', conditionJson: '{}' }, { kind: 'wait' }, { kind: 'email', emailTemplateId: 15 }] },
      scheduleFilters: JSON.stringify({ automationType: 'generic_channel_event', channel: 'EMAIL', triggerEvent: 'contact.status_changed' }),
    }]);

    expect(await processGenericChannelCampaignEvent('contact.status_changed', { contactId: 7, eventId: 'status-1' }, 1)).toEqual({ enrolled: 1 });
    expect(prisma.sequenceEnrollment.create).toHaveBeenCalledWith({ data: expect.objectContaining({ sequenceId: 94, currentStep: 0 }) });
  });

  test('matches payment-due campaigns only at their configured pre-due offset', async () => {
    prisma.invoice = { findFirst: vi.fn().mockResolvedValue({ id: 88, contactId: 7, status: 'UNPAID' }) };
    prisma.campaign.findMany.mockResolvedValue([{
      id: 27,
      channel: 'SMS',
      sequence: { id: 95, isActive: true, steps: [{ kind: 'sms', smsBody: 'Due soon' }] },
      scheduleFilters: JSON.stringify({ automationType: 'generic_channel_event', channel: 'SMS', triggerEvent: 'payment.due', dueBefore: { amount: 2, unit: 'days' } }),
    }]);

    expect(await processGenericChannelCampaignEvent('payment.due', { invoiceId: 88, contactId: 7, eventId: 'wrong-offset', dueBeforeMinutes: 1440 }, 1)).toEqual({ enrolled: 0 });
    expect(await processGenericChannelCampaignEvent('payment.due', { invoiceId: 88, contactId: 7, eventId: 'right-offset', dueBeforeMinutes: 2880 }, 1)).toEqual({ enrolled: 1 });
  });

  test('runs an event action only when its Generic CRM lead field filters match', async () => {
    prisma.contact.findFirst.mockResolvedValue({ id: 7, status: 'Lead', source: 'Website', email: 'lead@example.com', phone: '9876543210' });
    prisma.campaign.findMany.mockResolvedValue([{
      id: 25,
      channel: 'EMAIL',
      sequenceId: 93,
      sequence: { id: 93, isActive: true, steps: [{ kind: 'email', emailTemplateId: 14 }] },
      scheduleFilters: JSON.stringify({
        automationType: 'generic_channel_event', channel: 'EMAIL', triggerEvent: 'contact.updated', templateId: 14,
        conditions: [{ field: 'contact.source', op: 'eq', value: 'Website' }], conditionLogic: 'AND',
      }),
    }]);

    expect(await processGenericChannelCampaignEvent('contact.updated', { contactId: 7, eventId: 'source-match' }, 1)).toEqual({ enrolled: 1 });
    prisma.contact.findFirst.mockResolvedValue({ id: 7, status: 'Lead', source: 'Referral', email: 'lead@example.com', phone: '9876543210' });
    expect(await processGenericChannelCampaignEvent('contact.updated', { contactId: 7, eventId: 'source-miss' }, 1)).toEqual({ enrolled: 0 });
  });

  test('waits for the previous flow condition before enrolling the next action', async () => {
    prisma.campaign.findMany.mockResolvedValue([
      {
        id: 30, channel: 'SMS', sequenceId: 100,
        sequence: { id: 100, isActive: true, steps: [{ kind: 'sms', smsBody: 'Welcome' }] },
        scheduleFilters: JSON.stringify({ automationType: 'generic_channel_event', channel: 'SMS', triggerEvent: 'contact.created', templateId: 20, flowId: 'lead-flow', ruleOrder: 0 }),
      },
      {
        id: 31, channel: 'SMS', sequenceId: 101,
        sequence: { id: 101, isActive: true, steps: [{ kind: 'sms', smsBody: 'Pickup confirmed' }] },
        scheduleFilters: JSON.stringify({ automationType: 'generic_channel_event', channel: 'SMS', triggerEvent: 'contact.updated', templateId: 21, flowId: 'lead-flow', ruleOrder: 1 }),
      },
    ]);

    expect(await processGenericChannelCampaignEvent('contact.updated', { contactId: 7, eventId: 'before-first' }, 1)).toEqual({ enrolled: 0 });
    prisma.sequenceEnrollment.findFirst.mockImplementation(({ where }) => Promise.resolve(where.sequenceId === 100 ? { id: 700 } : null));
    expect(await processGenericChannelCampaignEvent('contact.updated', { contactId: 7, eventId: 'after-first' }, 1)).toEqual({ enrolled: 1 });
    expect(prisma.sequenceEnrollment.create).toHaveBeenCalledWith({ data: expect.objectContaining({ sequenceId: 101, currentStep: 0 }) });
  });
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

describe('Generic WhatsApp campaign triggers', () => {
  test('enrolls a durable multi-step WhatsApp sequence instead of sending only the first template', async () => {
    prisma.tenant.findUnique.mockResolvedValue({ name: 'NovaCrest', vertical: 'generic' });
    prisma.contact.findFirst.mockResolvedValue({ id: 7, name: 'Kanchan Gupta', phone: '9876543210' });
    prisma.whatsAppConfig = { findFirst: vi.fn().mockResolvedValue({ phoneNumberId: 'phone-id' }) };
    prisma.whatsAppOptOut = { findUnique: vi.fn().mockResolvedValue(null) };
    prisma.whatsAppTemplate = { findFirst: vi.fn() };
    prisma.whatsAppMessage = { findFirst: vi.fn(), create: vi.fn() };
    prisma.campaign.findMany.mockResolvedValue([{
      id: 77,
      sequenceId: 91,
      status: 'Active',
      channel: 'WHATSAPP',
      sequence: {
        id: 91,
        isActive: true,
        steps: [
          { id: 1, position: 0, kind: 'whatsapp', conditionJson: JSON.stringify({ version: 1, whatsappTemplateId: 9 }) },
          { id: 2, position: 1, kind: 'wait', delayMinutes: 1440 },
        ],
      },
      scheduleFilters: JSON.stringify({ automationType: 'whatsapp_event', eventTrigger: 'contact.created', whatsappTemplateId: 9 }),
    }]);

    expect(await processWhatsAppCampaignEvent('contact.created', { contactId: 7 }, 1)).toEqual({ queued: 1 });
    expect(prisma.sequenceEnrollment.create).toHaveBeenCalledWith({ data: expect.objectContaining({
      tenantId: 1,
      sequenceId: 91,
      contactId: 7,
      currentStep: 0,
      status: 'Active',
    }) });
    expect(prisma.whatsAppTemplate.findFirst).not.toHaveBeenCalled();
    expect(prisma.whatsAppMessage.create).not.toHaveBeenCalled();
  });

  test('hydrates selected pickup, plot and booking details for confirmation templates', async () => {
    prisma.plotBooking = { findFirst: vi.fn().mockResolvedValue({ id: 70, contactId: 7, customerPickupId: 80, plotSiteId: 90, status: 'BOOKING_CONFIRMED' }) };
    prisma.customerPickup = { findFirst: vi.fn().mockResolvedValue({ id: 80, contactId: 7, pickupAddress: 'Airport Gate 2' }) };
    prisma.plotSite = { findFirst: vi.fn().mockResolvedValue({ id: 90, name: 'Green Acres', plotNumber: 'A-12' }) };
    prisma.contact.findFirst.mockResolvedValue({ id: 7, name: 'Kanchan Gupta', phone: '9876543210', interestedPlotArea: 'Green Acres - Plot A-12' });

    const hydrated = await hydrateGenericEventPayload('plot.confirmed', { bookingId: 70, contactId: 7 }, 1);

    expect(hydrated.pickup).toMatchObject({ address: 'Airport Gate 2' });
    expect(hydrated.plot).toMatchObject({ name: 'Green Acres', plotNumber: 'A-12' });
    expect(hydrated.booking).toMatchObject({ status: 'BOOKING_CONFIRMED' });
    expect(hydrated.contact).toMatchObject({ interestedPlotArea: 'Green Acres - Plot A-12' });
  });

  test('supports AND/OR standard and custom lead field conditions', () => {
    const contact = { source: 'Website', custom_44: 'Residential' };
    expect(matchesEventConditions({
      conditionLogic: 'AND',
      conditions: [
        { field: 'contact.source', op: 'eq', value: 'Website' },
        { field: 'contact.field', key: 'custom_44', op: 'eq', value: 'Residential' },
      ],
    }, contact, 'contact.updated')).toBe(true);
    expect(matchesEventConditions({
      conditionLogic: 'OR',
      conditions: [
        { field: 'contact.source', op: 'eq', value: 'Referral' },
        { field: 'contact.field', key: 'custom_44', op: 'eq', value: 'Residential' },
      ],
    }, contact, 'contact.updated')).toBe(true);
  });

  test('matches any selected value for multi-value CRM conditions', () => {
    const contact = { source: 'Referral', status: 'Prospect', lifecycleStageKey: 'qualified' };
    expect(matchesEventConditions({
      conditionLogic: 'AND',
      conditions: [{ field: 'contact.source', op: 'eq', value: ['Website', 'Referral'] }],
    }, contact, 'contact.updated')).toBe(true);
    expect(matchesEventConditions({
      conditionLogic: 'AND',
      conditions: [{ field: 'contact.status', op: 'neq', value: ['Lead', 'Customer'] }],
    }, contact, 'contact.updated')).toBe(true);
    expect(matchesEventConditions({
      conditionLogic: 'AND',
      conditions: [{ field: 'contact.lifecycleStageKey', op: 'eq', value: ['interested', 'qualified'] }],
    }, contact, 'contact.status_changed')).toBe(true);
  });

  test('maps approved-template variables from the event context', () => {
    expect(templateParameterValues({ body: 'Hi {{1}}, payment {{2}}', variableMapping: JSON.stringify({ 1: 'contact.first_name', 2: 'payment.amount' }) }, {
      contact: { first_name: 'Kanchan' }, payment: { amount: 2500 },
    })).toEqual([{ type: 'text', text: 'Kanchan' }, { type: 'text', text: '2500' }]);
  });

  test('queues the selected template once for a successful payment', async () => {
    prisma.tenant.findUnique.mockResolvedValue({ name: 'NovaCrest', vertical: 'generic' });
    prisma.payment = { findFirst: vi.fn().mockResolvedValue({ id: 81, status: 'SUCCESS', contactId: 7, amount: 2500 }) };
    prisma.contact.findFirst.mockResolvedValue({ id: 7, name: 'Kanchan Gupta', phone: '9876543210' });
    prisma.whatsAppConfig = { findFirst: vi.fn().mockResolvedValue({ phoneNumberId: 'phone-id' }) };
    prisma.whatsAppOptOut = { findUnique: vi.fn().mockResolvedValue(null) };
    prisma.campaign.findMany.mockResolvedValue([
      { id: 22, status: 'Active', channel: 'WHATSAPP', scheduleFilters: JSON.stringify({ automationType: 'whatsapp_event', eventTrigger: 'payment.collected', whatsappTemplateId: 9 }) },
      { id: 18, status: 'Active', channel: 'WHATSAPP', scheduleFilters: JSON.stringify({ automationType: 'whatsapp_event', eventTrigger: 'payment.collected', whatsappTemplateId: 10 }) },
    ]);
    prisma.whatsAppTemplate = { findFirst: vi.fn(({ where }) => Promise.resolve(where.id === 9
      ? { id: 9, name: 'payment_done', body: 'Hi {{1}}', variableMapping: '{"1":"contact.first_name"}' }
      : { id: 10, name: 'old_wrong_template', body: 'Wrong template', variableMapping: null })) };
    prisma.whatsAppMessage = { findFirst: vi.fn().mockResolvedValue(null), create: vi.fn().mockResolvedValue({ id: 50 }) };
    prisma.waOutboundJob = { create: vi.fn().mockResolvedValue({ id: 90, status: 'PENDING' }) };
    prisma.whatsAppThread = {
      upsert: vi.fn().mockResolvedValue({ id: 70, contactPhone: '+919876543210', unreadCount: 0 }),
      findMany: vi.fn().mockResolvedValue([]),
    };
    prisma.campaign.update = vi.fn().mockResolvedValue({});

    const result = await processWhatsAppCampaignEvent('payment.collected', { paymentId: 81, contactId: 7 }, 1);

    expect(result).toEqual({ queued: 1 });
    expect(prisma.campaign.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ status: { in: ['Active', 'Scheduled'] }, channel: 'WHATSAPP' }),
      orderBy: [{ scheduledAt: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
    }));
    expect(prisma.whatsAppTemplate.findFirst).toHaveBeenCalledTimes(1);
    expect(prisma.whatsAppTemplate.findFirst.mock.calls[0][0].where.id).toBe(9);
    expect(prisma.whatsAppMessage.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ templateName: 'payment_done', body: 'Hi Kanchan', contactId: 7 }) }));
    expect(prisma.whatsAppMessage.findFirst.mock.calls[0][0].where.interactiveJson.contains).toContain('22:payment.collected:81');
  });

  test('fills the secure pickup/plot link in the selected WhatsApp template', async () => {
    prisma.tenant.findUnique.mockResolvedValue({ name: 'NovaCrest', vertical: 'generic' });
    prisma.contact.findFirst.mockResolvedValue({ id: 7, name: 'Kanchan Gupta', phone: '9876543210' });
    prisma.whatsAppConfig = { findFirst: vi.fn().mockResolvedValue({ phoneNumberId: 'phone-id' }) };
    prisma.whatsAppOptOut = { findUnique: vi.fn().mockResolvedValue(null) };
    prisma.campaign.findMany.mockResolvedValue([{
      id: 25,
      status: 'Active',
      channel: 'WHATSAPP',
      scheduleFilters: JSON.stringify({ automationType: 'whatsapp_event', eventTrigger: 'pickup_plot.selection_requested', whatsappTemplateId: 14 }),
    }]);
    prisma.whatsAppTemplate = { findFirst: vi.fn().mockResolvedValue({
      id: 14,
      name: 'generic_pickup_plot_request',
      body: 'Hi {{1}}, select here: {{3}}. Thank you from {{2}}.',
      variableMapping: JSON.stringify({ 1: 'contact.first_name', 2: 'organization.name', 3: 'system.pickupPlotLink' }),
    }) };
    prisma.whatsAppMessage = { findFirst: vi.fn().mockResolvedValue(null), create: vi.fn().mockResolvedValue({ id: 51 }) };
    prisma.whatsAppThread = {
      upsert: vi.fn().mockResolvedValue({ id: 71, contactPhone: '+919876543210', unreadCount: 0 }),
      findMany: vi.fn().mockResolvedValue([]),
    };
    prisma.campaign.update = vi.fn().mockResolvedValue({});

    expect(await processWhatsAppCampaignEvent('pickup_plot.selection_requested', { contactId: 7 }, 1)).toEqual({ queued: 1 });
    expect(prisma.whatsAppMessage.create.mock.calls[0][0].data.body)
      .toMatch(/^Hi Kanchan, select here: http:\/\/localhost:5173\/pickup-plot-selection\/.+\. Thank you from NovaCrest\.$/);
  });
});
