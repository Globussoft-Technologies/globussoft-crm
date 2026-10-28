import { beforeEach, describe, expect, test, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createRequire } from 'node:module';
import prisma from '../../lib/prisma.js';

const requireCJS = createRequire(import.meta.url);

const emailSender = requireCJS('../../lib/emailSender');
emailSender.sendEmail = vi.fn();
const smsProvider = requireCJS('../../services/smsProvider');
smsProvider.resolveProviderConfig = vi.fn();
smsProvider.sendSms = vi.fn();
const assignmentWhatsApp = requireCJS('../../lib/pickupPlotAssignmentWhatsApp');
assignmentWhatsApp.safeNotifyCustomerPickupPlotAssignments = vi.fn();
const paymentLink = requireCJS('../../lib/paymentLink');
paymentLink.createInvoicePaymentLink = vi.fn();
const eventBus = requireCJS('../../lib/eventBus');
eventBus.emitEvent = vi.fn().mockResolvedValue();
const callifiedClient = requireCJS('../../services/callifiedClient');
callifiedClient.listCampaigns = vi.fn();
callifiedClient.initiateCallForContact = vi.fn();
callifiedClient.normalizeCallifiedPhone = vi.fn((phone) => String(phone || ''));
const callifiedBridge = requireCJS('../../lib/callifiedAgentBridge');
callifiedBridge.startBrowserCall = vi.fn();
const callifiedDnpRetry = requireCJS('../../lib/callifiedDnpRetryEngine');
callifiedDnpRetry.clearDnpRetryState = vi.fn();
const audit = requireCJS('../../lib/audit');
audit.writeAudit = vi.fn();
const { createSelectionToken } = requireCJS('../../lib/genericPickupPlotSelection');

prisma.tenant = prisma.tenant || {};
prisma.pickupLocation = prisma.pickupLocation || {};
prisma.plotSite = prisma.plotSite || {};
prisma.transportPerson = prisma.transportPerson || {};
prisma.plotBroker = prisma.plotBroker || {};
prisma.billingPerson = prisma.billingPerson || {};
prisma.customerPickup = prisma.customerPickup || {};
prisma.invoice = prisma.invoice || {};
prisma.payment = prisma.payment || {};
prisma.plotBooking = prisma.plotBooking || {};
prisma.plotCommission = prisma.plotCommission || {};
prisma.plotInstallment = prisma.plotInstallment || {};
prisma.plotInvoiceItem = prisma.plotInvoiceItem || {};
prisma.plotWorkflowEvent = prisma.plotWorkflowEvent || {};
prisma.contact = prisma.contact || {};
prisma.callLog = prisma.callLog || {};
prisma.role = prisma.role || {};
prisma.user = prisma.user || {};
prisma.userRole = prisma.userRole || {};
for (const model of [prisma.tenant, prisma.pickupLocation, prisma.plotSite, prisma.transportPerson, prisma.plotBroker, prisma.billingPerson, prisma.customerPickup, prisma.contact, prisma.user, prisma.role]) {
  model.findFirst = vi.fn();
}
prisma.pickupLocation.findMany = vi.fn();
prisma.pickupLocation.create = vi.fn();
prisma.pickupLocation.update = vi.fn();
prisma.plotSite.findMany = vi.fn();
prisma.plotSite.create = vi.fn();
prisma.plotSite.update = vi.fn();
prisma.plotSite.updateMany = vi.fn();
prisma.contact.findMany = vi.fn();
prisma.contact.update = vi.fn();
prisma.callLog.findFirst = vi.fn();
prisma.user.findMany = vi.fn();
prisma.user.create = vi.fn();
prisma.user.update = vi.fn();
prisma.role.findMany = vi.fn();
prisma.userRole.findMany = vi.fn();
prisma.userRole.create = vi.fn();
prisma.transportPerson.findMany = vi.fn();
prisma.transportPerson.create = vi.fn();
prisma.transportPerson.update = vi.fn();
prisma.transportPerson.updateMany = vi.fn();
prisma.transportPerson.upsert = vi.fn();
prisma.plotBroker.findMany = vi.fn();
prisma.plotBroker.create = vi.fn();
prisma.plotBroker.update = vi.fn();
prisma.plotBroker.updateMany = vi.fn();
prisma.plotBroker.upsert = vi.fn();
prisma.billingPerson.findMany = vi.fn();
prisma.billingPerson.create = vi.fn();
prisma.billingPerson.update = vi.fn();
prisma.billingPerson.updateMany = vi.fn();
prisma.billingPerson.upsert = vi.fn();
prisma.customerPickup.findMany = vi.fn();
prisma.customerPickup.findUnique = vi.fn();
prisma.customerPickup.upsert = vi.fn();
prisma.invoice.findFirst = vi.fn();
prisma.invoice.create = vi.fn();
prisma.invoice.update = vi.fn();
prisma.payment.create = vi.fn();
prisma.payment.findFirst = vi.fn();
prisma.payment.findMany = vi.fn();
prisma.payment.update = vi.fn();
prisma.plotBooking.findFirst = vi.fn();
prisma.plotBooking.findMany = vi.fn();
prisma.plotBooking.create = vi.fn();
prisma.plotBooking.update = vi.fn();
prisma.plotBooking.updateMany = vi.fn();
prisma.plotCommission.findMany = vi.fn();
prisma.plotCommission.findFirst = vi.fn();
prisma.plotCommission.upsert = vi.fn();
prisma.plotCommission.create = vi.fn();
prisma.plotCommission.update = vi.fn();
prisma.plotCommission.updateMany = vi.fn();
prisma.plotInstallment.findMany = vi.fn();
prisma.plotInstallment.findFirst = vi.fn();
prisma.plotInstallment.create = vi.fn();
prisma.plotInstallment.deleteMany = vi.fn();
prisma.plotInstallment.update = vi.fn();
prisma.plotInstallment.updateMany = vi.fn();
prisma.plotInvoiceItem.create = vi.fn();
prisma.plotInvoiceItem.updateMany = vi.fn();
prisma.plotWorkflowEvent.create = vi.fn();
prisma.plotWorkflowEvent.findMany = vi.fn();
prisma.$transaction = vi.fn(async (callback) => callback(prisma));
prisma.$queryRaw = vi.fn();

const auth = requireCJS('../../middleware/auth');
auth.verifyToken = (_req, _res, next) => next();
const permissionMiddleware = requireCJS('../../middleware/requirePermission');
const router = requireCJS('../../routes/pickup_plot_inventory');

function makeApp({ tenantId = 7, role = 'ADMIN', isOwner = true } = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    // Route-behaviour suite: permission middleware is covered separately.
    // Treat the fixture actor as an owner so workspace RBAC does not mask the
    // workflow assertions below.
    req.user = { userId: 3, tenantId, role, vertical: 'generic', isOwner };
    next();
  });
  app.use('/api/pickup-plot-inventory', router);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  prisma.$transaction.mockImplementation(async operation => (
    typeof operation === 'function' ? operation(prisma) : Promise.all(operation)
  ));
  permissionMiddleware.clearAllCache();
  prisma.$queryRaw.mockResolvedValue([{ id: 41 }]);
  prisma.plotSite.updateMany.mockResolvedValue({ count: 1 });
  prisma.tenant.findUnique = vi.fn().mockResolvedValue({ vertical: 'generic' });
  prisma.plotCommission.findMany.mockResolvedValue([]);
  prisma.plotInstallment.findMany.mockResolvedValue([]);
  prisma.plotInstallment.findFirst.mockResolvedValue(null);
  prisma.plotInstallment.updateMany.mockReset().mockResolvedValue({ count: 1 });
  prisma.customerPickup.findUnique.mockResolvedValue(null);
  prisma.transportPerson.updateMany.mockResolvedValue({ count: 1 });
  prisma.plotBroker.updateMany.mockResolvedValue({ count: 1 });
  prisma.tenant.findFirst.mockResolvedValue({ vertical: 'generic' });
  prisma.pickupLocation.findMany.mockResolvedValue([]);
  prisma.plotSite.findMany.mockResolvedValue([]);
  prisma.contact.findMany.mockResolvedValue([]);
  prisma.transportPerson.findMany.mockResolvedValue([]);
  prisma.plotBroker.findMany.mockResolvedValue([]);
  prisma.billingPerson.findMany.mockResolvedValue([]);
  prisma.billingPerson.findFirst.mockResolvedValue(null);
  prisma.customerPickup.findMany.mockResolvedValue([]);
  prisma.customerPickup.findFirst.mockResolvedValue(null);
  prisma.role.findMany.mockResolvedValue([]);
  prisma.user.findFirst.mockResolvedValue(null);
  prisma.user.findMany.mockResolvedValue([]);
  prisma.contact.findFirst.mockResolvedValue(null);
  prisma.callLog.findFirst.mockResolvedValue(null);
  prisma.plotBooking.findFirst.mockResolvedValue(null);
  callifiedClient.listCampaigns.mockResolvedValue([]);
  callifiedClient.initiateCallForContact.mockResolvedValue({ callifiedLeadId: 901, callId: 'call-ai-1' });
  callifiedBridge.startBrowserCall.mockResolvedValue({ callifiedLeadId: 902, callSid: 'call-manual-1', bridgeTicket: 'ticket', bridgePath: '/ws/callified-agent' });
  callifiedDnpRetry.clearDnpRetryState.mockResolvedValue();
  audit.writeAudit.mockResolvedValue();
  prisma.plotBooking.findMany.mockResolvedValue([]);
  prisma.plotBooking.create.mockResolvedValue({ id: 91, bookingNumber: 'BOOK-TEST', status: 'PLOT_RESERVED' });
  prisma.plotBooking.update.mockResolvedValue({ id: 91 });
  prisma.plotBooking.updateMany.mockResolvedValue({ count: 1 });
  prisma.plotInvoiceItem.create.mockResolvedValue({ id: 101 });
  prisma.plotWorkflowEvent.create.mockResolvedValue({ id: 111 });
  prisma.plotWorkflowEvent.findMany.mockResolvedValue([]);
  prisma.payment.findFirst.mockResolvedValue(null);
  prisma.payment.findMany.mockResolvedValue([]);
  emailSender.sendEmail.mockResolvedValue({ sent: true });
  smsProvider.resolveProviderConfig.mockResolvedValue(null);
  smsProvider.sendSms.mockResolvedValue({ success: true });
  assignmentWhatsApp.safeNotifyCustomerPickupPlotAssignments.mockResolvedValue({ sent: 0, code: 'NO_NEW_ASSIGNMENTS' });
  paymentLink.createInvoicePaymentLink.mockResolvedValue({
    url: 'https://pay.example.test/plot-booking', gateway: 'razorpay', paymentId: 801,
  });
  prisma.user.findMany.mockResolvedValue([]);
  prisma.role.findMany.mockResolvedValue([]);
  prisma.pickupLocation.findFirst.mockResolvedValue(null);
  prisma.plotSite.findFirst.mockResolvedValue(null);
  prisma.invoice.findFirst.mockResolvedValue(null);
  prisma.payment.findFirst.mockResolvedValue(null);
  prisma.plotBooking.findFirst.mockResolvedValue(null);
  prisma.plotBooking.create.mockResolvedValue({ id: 91, bookingNumber: 'BOOK-ABC123', status: 'PLOT_RESERVED' });
  prisma.plotWorkflowEvent.findMany.mockResolvedValue([]);
});

test('saves a public pickup/plot selection and emits its sequence event', async () => {
  const token = createSelectionToken({ tenantId: 7, contactId: 61, submissionId: 5 });
  prisma.tenant.findFirst.mockResolvedValue({ id: 7, vertical: 'generic' });
  prisma.contact.findFirst.mockResolvedValue({ id: 61 });
  prisma.pickupLocation.findFirst.mockResolvedValue({ id: 12, address: 'Central Station' });
  prisma.plotSite.findFirst.mockResolvedValue({ id: 30, name: 'Green Acres', plotNumber: 'A-1', price: 250000, availability: 'AVAILABLE' });
  prisma.customerPickup.upsert.mockResolvedValue({ id: 71, contactId: 61, pickupAddress: 'Central Station' });
  prisma.plotBooking.findFirst.mockResolvedValue(null);
  prisma.plotBooking.create.mockResolvedValue({ id: 91, bookingNumber: 'BOOK-TEST' });

  const response = await request(makeApp())
    .post(`/api/pickup-plot-inventory/public/selection/${token}`)
    .send({ pickupLocationId: 12, plotSiteId: 30 });

  expect(response.status, JSON.stringify(response.body)).toBe(200);
  expect(eventBus.emitEvent).toHaveBeenCalledWith('pickup_plot.selected', expect.objectContaining({
    contactId: 61,
    pickupPointId: 71,
    plotSiteId: 30,
    bookingId: 91,
  }), 7);
  expect(prisma.$queryRaw.mock.calls.some(([parts]) => parts.join('').includes('FOR UPDATE'))).toBe(true);
});

test('returns a completed state instead of selection options after the public link was used', async () => {
  const token = createSelectionToken({ tenantId: 7, contactId: 61, submissionId: 5 });
  prisma.tenant.findFirst.mockResolvedValue({ id: 7, vertical: 'generic' });
  prisma.contact.findFirst.mockResolvedValue({ id: 61, name: 'Kanchan' });
  prisma.customerPickup.findFirst.mockResolvedValue({ id: 71 });

  const response = await request(makeApp())
    .get(`/api/pickup-plot-inventory/public/selection/${token}`);

  expect(response.status, JSON.stringify(response.body)).toBe(200);
  expect(response.body).toEqual({ completed: true, contact: { name: 'Kanchan' } });
  expect(response.body.pickupLocations).toBeUndefined();
  expect(response.body.plots).toBeUndefined();
});

test('rejects a repeated public pickup/plot submission without changing the selection', async () => {
  const token = createSelectionToken({ tenantId: 7, contactId: 61, submissionId: 5 });
  prisma.tenant.findFirst.mockResolvedValue({ id: 7, vertical: 'generic' });
  prisma.contact.findFirst.mockResolvedValue({ id: 61 });
  prisma.pickupLocation.findFirst.mockResolvedValue({ id: 12, address: 'Central Station' });
  prisma.plotSite.findFirst.mockResolvedValue({ id: 30, name: 'Green Acres', plotNumber: 'A-1', price: 250000, availability: 'AVAILABLE' });
  prisma.customerPickup.findFirst.mockResolvedValue({ id: 71 });

  const response = await request(makeApp())
    .post(`/api/pickup-plot-inventory/public/selection/${token}`)
    .send({ pickupLocationId: 12, plotSiteId: 30 });

  expect(response.status, JSON.stringify(response.body)).toBe(409);
  expect(response.body).toEqual({
    error: 'This selection link has already been used.',
    code: 'SELECTION_ALREADY_COMPLETED',
    completed: true,
  });
  expect(prisma.contact.update).not.toHaveBeenCalled();
  expect(prisma.customerPickup.upsert).not.toHaveBeenCalled();
  expect(prisma.plotBooking.create).not.toHaveBeenCalled();
  expect(eventBus.emitEvent).not.toHaveBeenCalled();
});

describe('Generic CRM admin workspace overview', () => {
  test('shows transport assignments across all linked staff profiles', async () => {
    prisma.transportPerson.findMany.mockResolvedValue([
      {
        id: 41, userId: 21, name: 'Sant Kumar', isActive: true,
        assignmentPairsJson: JSON.stringify([{ customerId: 61, plotSiteId: 30 }]),
        pickupLocationIdsJson: JSON.stringify([4]), assignmentStatusJson: null,
      },
      {
        id: 42, userId: 22, name: 'Harish Rao', isActive: true,
        assignmentPairsJson: JSON.stringify([{ customerId: 62, plotSiteId: 31 }]),
        pickupLocationIdsJson: JSON.stringify([5]), assignmentStatusJson: null,
      },
    ]);
    prisma.contact.findMany.mockResolvedValue([
      { id: 61, name: 'Priya Shah' }, { id: 62, name: 'Li Wei' },
    ]);
    prisma.plotSite.findMany.mockResolvedValue([
      { id: 30, name: 'Plot 30' }, { id: 31, name: 'Plot 31' },
    ]);

    const response = await request(makeApp({ role: 'ADMIN' }))
      .get('/api/pickup-plot-inventory/transport-persons/me');

    expect(response.status).toBe(200);
    expect(response.body.isAdminOverview).toBe(true);
    expect(response.body.transportPerson).toBeNull();
    expect(response.body.assignments.map((row) => row.assignedStaff.name)).toEqual(['Sant Kumar', 'Harish Rao']);
  });

  test('updates the selected Transport profile from the admin overview', async () => {
    prisma.transportPerson.findFirst.mockResolvedValue({
      id: 41, userId: 21, tenantId: 7, name: 'Sant Kumar', isActive: true,
      assignmentPairsJson: '[{"customerId":61,"plotSiteId":30}]',
      pickupLocationIdsJson: '[4]', assignmentStatusJson: null,
      updatedAt: new Date('2026-10-07T00:00:00Z'),
    });

    const response = await request(makeApp({ role: 'ADMIN' }))
      .patch('/api/pickup-plot-inventory/transport-persons/me/assignments/customer-61-plot-30/status?assignedProfileId=41')
      .send({ status: 'ACCEPTED' });

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(prisma.transportPerson.findFirst).toHaveBeenCalledWith({
      where: { tenantId: 7, id: 41, isActive: true },
    });
    expect(response.body.status).toBe('ACCEPTED');
  });

  test('shows only site-visit assignments with a live plot across linked sales executives', async () => {
    prisma.plotBroker.findMany.mockResolvedValue([
      {
        id: 51, userId: 31, name: 'Sanjeev', isActive: true,
        assignmentPairsJson: JSON.stringify([{ customerId: 61, plotSiteId: 30 }]),
        workflowStatusJson: null,
      },
      {
        id: 52, userId: 32, name: 'Anita', isActive: true,
        customerIdsJson: JSON.stringify([62]), plotSiteIdsJson: null,
        workflowStatusJson: null,
      },
    ]);
    prisma.transportPerson.findMany.mockResolvedValue([]);
    prisma.contact.findMany.mockResolvedValue([
      { id: 61, name: 'Priya Shah' }, { id: 62, name: 'Li Wei' },
    ]);
    prisma.plotSite.findMany.mockResolvedValue([
      { id: 30, name: 'Plot 30' }, { id: 31, name: 'Plot 31' },
    ]);

    const response = await request(makeApp({ role: 'ADMIN' }))
      .get('/api/pickup-plot-inventory/brokers/me');

    expect(response.status).toBe(200);
    expect(response.body.isAdminOverview).toBe(true);
    expect(response.body.broker).toBeNull();
    expect(response.body.customers.map((row) => row.assignedStaff.name)).toEqual(['Sanjeev']);
    expect(response.body.summary).toEqual({ total: 1, completed: 0, waiting: 1 });
    expect(prisma.plotSite.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        tenantId: 7,
        isActive: true,
        id: { in: [30] },
      }),
    }));
  });

  test('shows completed transport handoffs that still need a Sales Executive assignment', async () => {
    prisma.plotBroker.findMany.mockResolvedValue([]);
    prisma.transportPerson.findMany.mockResolvedValue([{
      id: 41, name: 'Sant Kumar', isActive: true,
      assignmentPairsJson: '[{"customerId":61,"plotSiteId":30}]',
      assignmentStatusJson: '{"customer-61-plot-30":{"status":"COMPLETED","updatedAt":"2026-10-15T10:00:00.000Z","pickupAt":"2026-10-15T09:20:00.000Z","dropOffAt":"2026-10-15T10:00:00.000Z"}}',
    }]);
    prisma.contact.findMany.mockResolvedValue([{ id: 61, name: 'Priya Shah' }]);
    prisma.plotSite.findMany.mockResolvedValue([{ id: 30, name: 'Plot 30' }]);

    const response = await request(makeApp({ role: 'ADMIN' }))
      .get('/api/pickup-plot-inventory/brokers/me');

    expect(response.status).toBe(200);
    expect(response.body.customers).toEqual([
      expect.objectContaining({
        id: 61,
        tripCompleted: true,
        pickupAt: '2026-10-15T09:20:00.000Z',
        dropOffAt: '2026-10-15T10:00:00.000Z',
        awaitingAssignment: true,
        assignedStaff: null,
      }),
    ]);
  });

  test('shows billing assignments across all linked billing staff', async () => {
    prisma.billingPerson.findMany.mockResolvedValue([
      {
        id: 71, userId: 41, name: 'Bina', isActive: true,
        assignmentPairsJson: JSON.stringify([{ customerId: 61, plotSiteId: 30 }]),
      },
      {
        id: 72, userId: 42, name: 'Meera', isActive: true,
        assignmentPairsJson: JSON.stringify([{ customerId: 62, plotSiteId: 31 }]),
      },
    ]);
    prisma.plotBroker.findMany.mockResolvedValue([
      {
        id: 51, name: 'Sanjeev', isActive: true,
        assignmentPairsJson: JSON.stringify([
          { customerId: 61, plotSiteId: 30 }, { customerId: 62, plotSiteId: 31 },
        ]),
        workflowStatusJson: JSON.stringify({
          'customer-61-plot-30': { status: 'PLOT_SELECTED', billingStatus: 'PLOT_RESERVED' },
          'customer-62-plot-31': { status: 'PLOT_SELECTED', billingStatus: 'PLOT_RESERVED' },
        }),
      },
    ]);
    prisma.contact.findMany.mockResolvedValue([
      { id: 61, name: 'Priya Shah' }, { id: 62, name: 'Li Wei' },
    ]);
    prisma.plotSite.findMany.mockResolvedValue([
      { id: 30, name: 'Plot 30' }, { id: 31, name: 'Plot 31' },
    ]);

    const response = await request(makeApp({ role: 'ADMIN' }))
      .get('/api/pickup-plot-inventory/billing/me');

    expect(response.status).toBe(200);
    expect(response.body.isAdminOverview).toBe(true);
    expect(response.body.billingUser).toBeNull();
    expect(response.body.assignments.map((row) => row.assignedStaff.name)).toEqual(['Bina', 'Meera']);
  });

  test('uses the paid booking ledger instead of stale payment-pending workflow JSON', async () => {
    prisma.billingPerson.findMany.mockResolvedValue([{
      id: 71, userId: 41, name: 'Sachin', isActive: true,
      assignmentPairsJson: '[{"customerId":61,"plotSiteId":30}]',
    }]);
    prisma.plotBroker.findMany.mockResolvedValue([{
      id: 51, name: 'Sanjeev', isActive: true,
      assignmentPairsJson: '[{"customerId":61,"plotSiteId":30}]',
      workflowStatusJson: JSON.stringify({
        'customer-61-plot-30': {
          status: 'PLOT_SELECTED', billingStatus: 'PAYMENT_PENDING', plotId: 30, bookingId: 501,
        },
      }),
    }]);
    prisma.contact.findMany.mockResolvedValue([{ id: 61, name: 'Manoj Kumar' }]);
    prisma.plotSite.findMany.mockResolvedValue([{ id: 30, name: 'Koramangala', plotNumber: '10' }]);
    prisma.plotBooking.findMany.mockResolvedValue([{
      id: 501, bookingNumber: 'BOOK-501', contactId: 61, plotSiteId: 30,
      status: 'PAYMENT_RECEIVED', paymentStatus: 'PAID', totalAmount: 200000,
      amountPaid: 200000, balance: 0,
    }]);

    const response = await request(makeApp({ role: 'ADMIN' }))
      .get('/api/pickup-plot-inventory/billing/me');

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.assignments[0]).toMatchObject({
      customer: { id: 61, name: 'Manoj Kumar' },
      status: 'PAYMENT_VERIFIED',
      paymentStatus: 'PAID',
      amountPaid: 200000,
      balance: 0,
    });
  });

  test('shows Sales Executive handoffs that still need a Billing assignment', async () => {
    prisma.billingPerson.findMany.mockResolvedValue([]);
    prisma.plotBroker.findMany.mockResolvedValue([{
      id: 51, name: 'Sanjeev', isActive: true,
      assignmentPairsJson: '[{"customerId":61,"plotSiteId":30}]',
      workflowStatusJson: '{"customer-61-plot-30":{"status":"PLOT_SELECTED","billingStatus":"PLOT_RESERVED"}}',
    }]);
    prisma.contact.findMany.mockResolvedValue([{ id: 61, name: 'Priya Shah' }]);
    prisma.plotSite.findMany.mockResolvedValue([{ id: 30, name: 'Plot 30' }]);

    const response = await request(makeApp({ role: 'ADMIN' }))
      .get('/api/pickup-plot-inventory/billing/me');

    expect(response.status).toBe(200);
    expect(response.body.assignments).toEqual([
      expect.objectContaining({
        customer: expect.objectContaining({ id: 61 }),
        awaitingAssignment: true,
        assignedStaff: null,
      }),
    ]);
  });

  test('assigns a completed transport handoff directly to a Sales Executive', async () => {
    prisma.plotBroker.findFirst.mockResolvedValue({
      id: 51, userId: 31, tenantId: 7, name: 'Sanjeev', customerIdsJson: null,
      plotSiteIdsJson: null, assignmentPairsJson: null, workflowStatusJson: null, isActive: true,
    });
    prisma.plotBroker.findMany.mockResolvedValue([]);
    prisma.transportPerson.findMany.mockResolvedValue([{
      id: 41,
      assignmentPairsJson: '[{"customerId":61,"plotSiteId":30}]',
      assignmentStatusJson: '{"customer-61-plot-30":{"status":"COMPLETED"}}',
    }]);
    const response = await request(makeApp({ role: 'ADMIN' }))
      .patch('/api/pickup-plot-inventory/brokers/me/assignments/awaiting-broker-customer-61-plot-30/assign')
      .send({ targetProfileId: 51 });

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.assignedStaff).toMatchObject({ profileId: 51, name: 'Sanjeev' });
    expect(prisma.plotBroker.update).toHaveBeenCalledWith({
      where: { id: 51 },
      data: {
        customerIdsJson: '[61]',
        plotSiteIdsJson: '[30]',
        assignmentPairsJson: '[{"customerId":61,"plotSiteId":30}]',
      },
    });
  });

  test('assigns a Sales Executive handoff directly to Billing staff', async () => {
    prisma.billingPerson.findFirst.mockResolvedValue({
      id: 71, userId: 41, tenantId: 7, name: 'Bina', customerIdsJson: null,
      plotSiteIdsJson: null, assignmentPairsJson: null, isActive: true,
    });
    prisma.billingPerson.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    prisma.plotBroker.findFirst.mockResolvedValue({
      id: 51, tenantId: 7, assignmentPairsJson: '[{"customerId":61,"plotSiteId":30}]',
      workflowStatusJson: '{"customer-61-plot-30":{"status":"PLOT_SELECTED","plotId":31}}',
      isActive: true,
    });

    const response = await request(makeApp({ role: 'ADMIN' }))
      .patch('/api/pickup-plot-inventory/billing/me/assignments/51-61-31/assign')
      .send({ targetProfileId: 71 });

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.assignedStaff).toMatchObject({ profileId: 71, name: 'Bina' });
    expect(prisma.billingPerson.update).toHaveBeenCalledWith({
      where: { id: 71 },
      data: {
        customerIdsJson: '[61]',
        plotSiteIdsJson: '[31]',
        assignmentPairsJson: '[{"customerId":61,"plotSiteId":31}]',
      },
    });
  });

  test('updates the selected Sales Executive profile from the admin overview', async () => {
    prisma.plotBroker.findFirst.mockResolvedValue({
      id: 51, userId: 31, tenantId: 7, customerIdsJson: '[61]', plotSiteIdsJson: '[30]',
      assignmentPairsJson: '[{"customerId":61,"plotSiteId":30}]',
      workflowStatusJson: '{"customer-61-plot-30":{"status":"VISIT_SCHEDULED"}}',
      updatedAt: new Date('2026-10-07T00:00:00Z'), isActive: true,
    });
    prisma.transportPerson.findMany.mockResolvedValue([{
      id: 41, assignmentPairsJson: '[{"customerId":61,"plotSiteId":30}]',
      assignmentStatusJson: '{"customer-61-plot-30":{"status":"COMPLETED"}}',
    }]);

    const response = await request(makeApp({ role: 'ADMIN' }))
      .patch('/api/pickup-plot-inventory/brokers/me/assignments/customer-61-plot-30/workflow?assignedProfileId=51')
      .send({ status: 'VISIT_CONFIRMED' });

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(prisma.plotBroker.findFirst).toHaveBeenCalledWith({
      where: { tenantId: 7, id: 51, isActive: true },
    });
    expect(response.body.status).toBe('VISIT_CONFIRMED');
  });

  test('updates the selected Billing profile from the admin overview', async () => {
    prisma.billingPerson.findFirst.mockResolvedValue({
      id: 71, userId: 41, tenantId: 7, name: 'Bina',
      assignmentPairsJson: '[{"customerId":61,"plotSiteId":31}]', isActive: true,
    });
    prisma.plotBroker.findFirst.mockResolvedValue({
      id: 51, tenantId: 7, assignmentPairsJson: '[{"customerId":61,"plotSiteId":30}]',
      workflowStatusJson: '{"customer-61-plot-30":{"status":"PLOT_SELECTED","billingStatus":"PLOT_RESERVED","plotId":31}}',
      updatedAt: new Date('2026-10-07T00:00:00Z'), isActive: true,
    });

    const response = await request(makeApp({ role: 'ADMIN' }))
      .patch('/api/pickup-plot-inventory/billing/me/assignments/51-61-31/status?assignedProfileId=71')
      .send({ status: 'BILLING' });

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(prisma.billingPerson.findFirst).toHaveBeenCalledWith({
      where: { tenantId: 7, id: 71, isActive: true },
    });
    expect(response.body.status).toBe('BILLING');
  });
});

describe('combined staff work assignment', () => {
  test('lists every active staff member with any existing work combination', async () => {
    prisma.user.findMany.mockResolvedValue([
      {
        id: 12,
        name: 'Asha Rao',
        email: 'asha@example.com',
        phone: '9000012345',
        role: 'USER',
        userType: 'STAFF',
        userRoles: [{ role: { key: 'BROKER' } }],
      },
      {
        id: 13,
        name: 'Generic Manager',
        email: 'manager@example.com',
        phone: '9000012346',
        role: 'MANAGER',
        userType: 'STAFF',
        userRoles: [{ role: { key: 'MANAGER' } }],
      },
      {
        id: 14,
        name: 'Tenant Admin',
        email: 'admin@example.com',
        phone: '9000012347',
        role: 'ADMIN',
        userType: 'STAFF',
        userRoles: [{ role: { key: 'ADMIN' } }],
      },
      {
        id: 15,
        name: 'Legacy User',
        email: 'user@example.com',
        phone: '9000012348',
        role: 'USER',
        userType: 'STAFF',
        userRoles: [],
      },
    ]);
    prisma.transportPerson.findMany.mockResolvedValue([{ id: 21, userId: 12, isActive: true }]);
    prisma.plotBroker.findMany.mockResolvedValue([{ id: 22, userId: 12, isActive: true }]);
    prisma.billingPerson.findMany.mockResolvedValue([{ id: 23, userId: 12, isActive: false }]);

    const response = await request(makeApp()).get('/api/pickup-plot-inventory/work-assignments');

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.staff).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 12,
        workTypes: ['transport', 'broker'],
        profiles: { transport: 21, broker: 22, billing: 23 },
      }),
      expect.objectContaining({ id: 15 }),
    ]));
    expect(response.body.staff.map((row) => row.id)).not.toEqual(expect.arrayContaining([13, 14]));
  });

  test('assigns any combination without replacing the staff member role', async () => {
    prisma.user.findFirst.mockResolvedValue({
      id: 12,
      tenantId: 7,
      name: 'Asha Rao',
      email: 'asha@example.com',
      phone: '9000012345',
      userType: 'STAFF',
      role: 'USER',
      userRoles: [{ role: { key: 'BROKER' } }],
    });
    prisma.transportPerson.upsert.mockResolvedValue({ id: 21 });
    prisma.plotBroker.upsert.mockResolvedValue({ id: 22 });
    prisma.billingPerson.updateMany.mockResolvedValue({ count: 0 });

    const response = await request(makeApp())
      .put('/api/pickup-plot-inventory/work-assignments')
      .send({ targetUserId: 12, workTypes: ['transport', 'broker'] });

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.workTypes).toEqual(['transport', 'broker']);
    expect(prisma.transportPerson.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { userId: 12 },
      update: { isActive: true },
    }));
    expect(prisma.plotBroker.upsert).toHaveBeenCalled();
    expect(prisma.billingPerson.updateMany).toHaveBeenCalledWith({
      where: { tenantId: 7, userId: 12 },
      data: { isActive: false },
    });
    expect(prisma.userRole.create).not.toHaveBeenCalled();
  });

  test('rejects Admin, Manager, Customer, and Owner roles', async () => {
    prisma.user.findFirst.mockResolvedValue({
      id: 14,
      tenantId: 7,
      name: 'Tenant Admin',
      email: 'admin@example.com',
      phone: '9000012347',
      role: 'ADMIN',
      userType: 'STAFF',
      userRoles: [{ role: { key: 'ADMIN' } }],
    });

    const response = await request(makeApp())
      .put('/api/pickup-plot-inventory/work-assignments')
      .send({ targetUserId: 14, workTypes: ['transport'] });

    expect(response.status).toBe(400);
    expect(response.body.code).toBe('STAFF_ROLE_NOT_ASSIGNABLE');
    expect(prisma.transportPerson.upsert).not.toHaveBeenCalled();
  });
});

describe('self-service work profile', () => {
  test('returns only the signed-in transport profile with its assigned plot', async () => {
    prisma.transportPerson.findFirst.mockResolvedValue({
      id: 41, userId: 3, tenantId: 7, alternatePhone: '9000099999',
      vehicleType: 'SUV', vehicleNumber: 'KA 01 AB 1234', notes: 'Call first',
      customerIdsJson: '[61]', plotSiteIdsJson: '[30]', pickupLocationIdsJson: '[4]',
      assignmentPairsJson: '[{"customerId":61,"plotSiteId":30}]', isActive: true,
    });
    prisma.plotSite.findMany.mockImplementation(({ where }) => Promise.resolve(
      where.isActive
        ? [{ id: 30, name: 'Plot 30', availability: 'AVAILABLE' }, { id: 31, name: 'Plot 31', availability: 'AVAILABLE' }]
        : [{ id: 30, name: 'Plot 30', availability: 'AVAILABLE' }],
    ));
    prisma.contact.findMany.mockResolvedValue([{ id: 61, name: 'Priya Shah', phone: '9000022222' }]);
    prisma.pickupLocation.findMany.mockImplementation(({ where }) => Promise.resolve(
      where.isActive
        ? [{ id: 4, name: 'North Gate', address: 'MG Road', isActive: true }, { id: 5, name: 'South Gate', address: 'Residency Road', isActive: true }]
        : [{ id: 4, name: 'North Gate', address: 'MG Road', isActive: true }],
    ));

    const response = await request(makeApp({ role: 'USER' })).get('/api/pickup-plot-inventory/people/me');

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(prisma.transportPerson.findFirst).toHaveBeenCalledWith({ where: { tenantId: 7, userId: 3 } });
    expect(response.body).toMatchObject({
      roleType: 'transport',
      profile: { id: 41, vehicleType: 'SUV', vehicleNumber: 'KA 01 AB 1234' },
      assignedPlots: [{ id: 30, name: 'Plot 30' }],
      assignedPickupLocations: [{ id: 4, name: 'North Gate' }],
      assignments: [{ customerId: 61, plotSiteId: 30, customer: { name: 'Priya Shah' }, plot: { name: 'Plot 30' } }],
    });
    expect(response.body.plotOptions).toEqual([
      expect.objectContaining({ id: 30, name: 'Plot 30' }),
      expect.objectContaining({ id: 31, name: 'Plot 31' }),
    ]);
    expect(response.body.pickupLocationOptions).toEqual([
      expect.objectContaining({ id: 4, name: 'North Gate' }),
      expect.objectContaining({ id: 5, name: 'South Gate' }),
    ]);
  });

  test.each([
    { roleType: 'transport', modelName: 'transportPerson', profileId: 41 },
    { roleType: 'broker', modelName: 'plotBroker', profileId: 51 },
    { roleType: 'billing', modelName: 'billingPerson', profileId: 71 },
  ])('hides fully completed customers from the $roleType self profile', async ({ roleType, modelName, profileId }) => {
    prisma.transportPerson.findFirst.mockResolvedValue(roleType === 'transport' ? {
      id: profileId, userId: 3, tenantId: 7, customerIdsJson: '[61,62]', plotSiteIdsJson: '[30,31]',
      assignmentPairsJson: '[{"customerId":61,"plotSiteId":30},{"customerId":62,"plotSiteId":31}]', isActive: true,
    } : null);
    prisma.plotBroker.findFirst.mockResolvedValue(roleType === 'broker' ? {
      id: profileId, userId: 3, tenantId: 7, customerIdsJson: '[61,62]', plotSiteIdsJson: '[30,31]',
      assignmentPairsJson: '[{"customerId":61,"plotSiteId":30},{"customerId":62,"plotSiteId":31}]', isActive: true,
    } : null);
    prisma.billingPerson.findFirst.mockResolvedValue(roleType === 'billing' ? {
      id: profileId, userId: 3, tenantId: 7, customerIdsJson: '[61,62]', plotSiteIdsJson: '[30,31]',
      assignmentPairsJson: '[{"customerId":61,"plotSiteId":30},{"customerId":62,"plotSiteId":31}]', isActive: true,
    } : null);
    prisma.plotSite.findMany.mockResolvedValue([
      { id: 30, name: 'Completed Plot', availability: 'SOLD' },
      { id: 31, name: 'Active Plot', availability: 'AVAILABLE' },
    ]);
    prisma.contact.findMany.mockResolvedValue([
      { id: 61, name: 'Completed Customer' },
      { id: 62, name: 'Active Customer' },
    ]);
    prisma.plotBooking.findMany.mockResolvedValue([{ contactId: 61 }]);

    const response = await request(makeApp({ role: 'USER' })).get('/api/pickup-plot-inventory/people/me');

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.roleType).toBe(roleType);
    expect(response.body.assignments).toEqual([
      expect.objectContaining({ customerId: 62, customer: expect.objectContaining({ name: 'Active Customer' }) }),
    ]);
    expect(JSON.stringify(response.body.assignments)).not.toContain('Completed Customer');
    expect(prisma[modelName].findFirst).toHaveBeenCalledWith({ where: { tenantId: 7, userId: 3 } });
  });

  test('hides a customer from the transport profile as soon as that trip is completed', async () => {
    prisma.transportPerson.findFirst.mockResolvedValue({
      id: 41, userId: 3, tenantId: 7, customerIdsJson: '[61,62]', plotSiteIdsJson: '[30,31]',
      assignmentPairsJson: '[{"customerId":61,"plotSiteId":30},{"customerId":62,"plotSiteId":31}]',
      assignmentStatusJson: JSON.stringify({
        'customer-61-plot-30': { status: 'COMPLETED' },
        'customer-62-plot-31': { status: 'ACCEPTED' },
      }),
      isActive: true,
    });
    prisma.plotSite.findMany.mockResolvedValue([
      { id: 30, name: 'Completed Trip Plot' },
      { id: 31, name: 'Active Trip Plot' },
    ]);
    prisma.contact.findMany.mockResolvedValue([
      { id: 61, name: 'Muskan' },
      { id: 62, name: 'Sarukh' },
    ]);
    prisma.plotBooking.findMany.mockResolvedValue([]);

    const response = await request(makeApp({ role: 'USER' })).get('/api/pickup-plot-inventory/people/me');

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.assignments).toEqual([
      expect.objectContaining({ customerId: 62, customer: expect.objectContaining({ name: 'Sarukh' }) }),
    ]);
    expect(JSON.stringify(response.body.assignments)).not.toContain('Muskan');
  });

  test('allows transport staff to change assigned pickup locations', async () => {
    prisma.transportPerson.findFirst.mockResolvedValue({
      id: 41, userId: 3, tenantId: 7, customerIdsJson: '[]', plotSiteIdsJson: '[]',
      pickupLocationIdsJson: '[4]', assignmentPairsJson: '[]', isActive: true,
    });
    prisma.pickupLocation.findMany.mockImplementation(({ where }) => Promise.resolve(
      where.isActive && where.id
        ? [{ id: 5 }]
        : where.isActive
          ? [{ id: 4, name: 'North Gate' }, { id: 5, name: 'South Gate' }]
          : [{ id: 5, name: 'South Gate' }],
    ));
    prisma.transportPerson.update.mockResolvedValue({
      id: 41, userId: 3, tenantId: 7, customerIdsJson: '[]', plotSiteIdsJson: '[]',
      pickupLocationIdsJson: '[5]', pickupLocationId: 5, assignmentPairsJson: '[]', isActive: true,
    });

    const response = await request(makeApp({ role: 'USER' }))
      .put('/api/pickup-plot-inventory/people/me')
      .send({ roleType: 'transport', pickupLocationIds: [5] });

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(prisma.transportPerson.update).toHaveBeenCalledWith({
      where: { id: 41 },
      data: expect.objectContaining({ pickupLocationIdsJson: '[5]', pickupLocationId: 5 }),
    });
    expect(response.body.assignedPickupLocations).toEqual([
      expect.objectContaining({ id: 5, name: 'South Gate' }),
    ]);
  });

  test.each([
    { roleType: 'broker', modelName: 'plotBroker', profileId: 51 },
    { roleType: 'billing', modelName: 'billingPerson', profileId: 71 },
  ])('rejects pickup-location changes from a $roleType profile', async ({ roleType, modelName, profileId }) => {
    prisma.transportPerson.findFirst.mockResolvedValue(null);
    prisma.plotBroker.findFirst.mockResolvedValue(roleType === 'broker'
      ? { id: profileId, userId: 3, tenantId: 7, assignmentPairsJson: '[]', isActive: true }
      : null);
    prisma.billingPerson.findFirst.mockResolvedValue(roleType === 'billing'
      ? { id: profileId, userId: 3, tenantId: 7, assignmentPairsJson: '[]', isActive: true }
      : null);

    const response = await request(makeApp({ role: 'USER' }))
      .put('/api/pickup-plot-inventory/people/me')
      .send({ roleType, pickupLocationIds: [5] });

    expect(response.status).toBe(403);
    expect(response.body.code).toBe('PICKUP_LOCATIONS_TRANSPORT_ONLY');
    expect(prisma[modelName].update).not.toHaveBeenCalled();
  });

  test('updates only work details and preserves the admin-managed assignments', async () => {
    prisma.transportPerson.findFirst.mockResolvedValue({
      id: 41, userId: 3, tenantId: 7, customerIdsJson: '[61]', plotSiteIdsJson: '[30]',
      assignmentPairsJson: '[{"customerId":61,"plotSiteId":30}]', isActive: true,
    });
    prisma.plotSite.findMany.mockResolvedValue([{ id: 30, name: 'Plot 30', availability: 'AVAILABLE' }]);
    prisma.contact.findMany.mockResolvedValue([{ id: 61, name: 'Priya Shah' }]);
    prisma.transportPerson.update.mockResolvedValue({
      id: 41, userId: 3, tenantId: 7, alternatePhone: '9000088888', vehicleType: 'Van',
      vehicleNumber: 'KA 02 CD 5678', notes: 'Updated', customerIdsJson: '[61]',
      plotSiteIdsJson: '[30]', assignmentPairsJson: '[{"customerId":61,"plotSiteId":30}]', isActive: true,
    });

    const response = await request(makeApp({ role: 'USER' }))
      .put('/api/pickup-plot-inventory/people/me')
      .send({
        roleType: 'transport', alternatePhone: '9000088888', vehicleType: 'Van',
        vehicleNumber: 'KA 02 CD 5678', notes: 'Updated',
      });

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(prisma.transportPerson.update).toHaveBeenCalledWith({
      where: { id: 41 },
      data: expect.objectContaining({
        alternatePhone: '9000088888', vehicleType: 'Van', vehicleNumber: 'KA 02 CD 5678',
      }),
    });
    expect(prisma.transportPerson.update.mock.calls[0][0].data).not.toHaveProperty('plotSiteIdsJson');
    expect(prisma.transportPerson.update.mock.calls[0][0].data).not.toHaveProperty('assignmentPairsJson');
  });

  test.each([
    { roleType: 'transport', modelName: 'transportPerson', profileId: 41 },
    { roleType: 'broker', modelName: 'plotBroker', profileId: 51 },
    { roleType: 'billing', modelName: 'billingPerson', profileId: 71 },
  ])('allows $roleType staff to change their separate assigned-plot list', async ({ roleType, modelName, profileId }) => {
    prisma.transportPerson.findFirst.mockResolvedValue(roleType === 'transport' ? {
      id: profileId, userId: 3, tenantId: 7, customerIdsJson: '[61]', plotSiteIdsJson: '[30]',
      assignmentPairsJson: '[{"customerId":61,"plotSiteId":30}]',
      assignmentStatusJson: '{"customer-61-plot-30":{"status":"COMPLETED"}}', isActive: true,
    } : null);
    prisma.plotBroker.findFirst.mockResolvedValue(roleType === 'broker' ? {
      id: profileId, userId: 3, tenantId: 7, customerIdsJson: '[61]', plotSiteIdsJson: '[30]',
      assignmentPairsJson: '[{"customerId":61,"plotSiteId":30}]',
      workflowStatusJson: '{"customer-61-plot-30":{"status":"PLOT_SELECTED"}}', isActive: true,
    } : null);
    prisma.billingPerson.findFirst.mockResolvedValue(roleType === 'billing' ? {
      id: profileId, userId: 3, tenantId: 7, customerIdsJson: '[61]', plotSiteIdsJson: '[30]',
      assignmentPairsJson: '[{"customerId":61,"plotSiteId":30}]', isActive: true,
    } : null);
    prisma.plotSite.findMany.mockImplementation(({ where }) => Promise.resolve(
      where.isActive && where.id
        ? [{ id: 31 }]
        : where.isActive
          ? [{ id: 30, name: 'Plot 30' }, { id: 31, name: 'Plot 31' }]
          : [{ id: 30, name: 'Plot 30' }, { id: 31, name: 'Plot 31' }],
    ));
    prisma.contact.findMany.mockResolvedValue([{ id: 61, name: 'Priya Shah' }]);
    if (roleType === 'billing') prisma.plotBooking.findMany.mockResolvedValue([{ contactId: 61 }]);
    prisma[modelName].update.mockResolvedValue({
      id: profileId, userId: 3, tenantId: 7, customerIdsJson: '[61]', plotSiteIdsJson: '[31]',
      assignmentPairsJson: '[{"customerId":61,"plotSiteId":30}]',
      ...(roleType === 'transport' ? { assignmentStatusJson: '{"customer-61-plot-30":{"status":"COMPLETED"}}' } : {}),
      ...(roleType === 'broker' ? { workflowStatusJson: '{"customer-61-plot-30":{"status":"PLOT_SELECTED"}}' } : {}),
      isActive: true,
    });
    const response = await request(makeApp({ role: 'USER' }))
      .put('/api/pickup-plot-inventory/people/me')
      .send({ roleType, plotSiteIds: [31] });

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(prisma[modelName].update).toHaveBeenCalledWith({
      where: { id: profileId },
      data: expect.objectContaining({
        plotSiteIdsJson: '[31]',
      }),
    });
    expect(prisma[modelName].update.mock.calls[0][0].data).not.toHaveProperty('assignmentPairsJson');
    expect(response.body.assignedPlots).toEqual([expect.objectContaining({ id: 31, name: 'Plot 31' })]);
    expect(response.body.assignments).toEqual([
    ]);
  });

  test.each([
    { roleType: 'transport', modelName: 'transportPerson', profileId: 41 },
    { roleType: 'broker', modelName: 'plotBroker', profileId: 51 },
    { roleType: 'billing', modelName: 'billingPerson', profileId: 71 },
  ])('prevents $roleType staff from changing plots while an assigned customer is incomplete', async ({ roleType, modelName, profileId }) => {
    prisma.transportPerson.findFirst.mockResolvedValue(roleType === 'transport' ? {
      id: profileId, userId: 3, tenantId: 7, customerIdsJson: '[61]', plotSiteIdsJson: '[30]',
      assignmentPairsJson: '[{"customerId":61,"plotSiteId":30}]', assignmentStatusJson: null, isActive: true,
    } : null);
    prisma.plotBroker.findFirst.mockResolvedValue(roleType === 'broker' ? {
      id: profileId, userId: 3, tenantId: 7, customerIdsJson: '[61]', plotSiteIdsJson: '[30]',
      assignmentPairsJson: '[{"customerId":61,"plotSiteId":30}]', workflowStatusJson: null, isActive: true,
    } : null);
    prisma.billingPerson.findFirst.mockResolvedValue(roleType === 'billing' ? {
      id: profileId, userId: 3, tenantId: 7, customerIdsJson: '[61]', plotSiteIdsJson: '[30]',
      assignmentPairsJson: '[{"customerId":61,"plotSiteId":30}]', isActive: true,
    } : null);

    const response = await request(makeApp({ role: 'USER' }))
      .put('/api/pickup-plot-inventory/people/me')
      .send({ roleType, plotSiteIds: [31] });

    expect(response.status).toBe(409);
    expect(response.body.code).toBe('ASSIGNED_CUSTOMERS_INCOMPLETE');
    expect(prisma[modelName].update).not.toHaveBeenCalled();
  });

  test('prevents transport staff from changing pickup locations while a trip is incomplete', async () => {
    prisma.transportPerson.findFirst.mockResolvedValue({
      id: 41, userId: 3, tenantId: 7, customerIdsJson: '[61]', plotSiteIdsJson: '[30]',
      pickupLocationIdsJson: '[4]', assignmentPairsJson: '[{"customerId":61,"plotSiteId":30}]',
      assignmentStatusJson: '{"customer-61-plot-30":{"status":"ACCEPTED"}}', isActive: true,
    });

    const response = await request(makeApp({ role: 'USER' }))
      .put('/api/pickup-plot-inventory/people/me')
      .send({ roleType: 'transport', pickupLocationIds: [5] });

    expect(response.status).toBe(409);
    expect(response.body.code).toBe('ASSIGNED_CUSTOMERS_INCOMPLETE');
    expect(prisma.transportPerson.update).not.toHaveBeenCalled();
  });

  test('allows saving other transport details when locked location selections are unchanged', async () => {
    prisma.transportPerson.findFirst.mockResolvedValue({
      id: 41, userId: 3, tenantId: 7, customerIdsJson: '[61]', plotSiteIdsJson: '[30]',
      pickupLocationIdsJson: '[4]', assignmentPairsJson: '[{"customerId":61,"plotSiteId":30}]',
      assignmentStatusJson: '{"customer-61-plot-30":{"status":"ACCEPTED"}}', isActive: true,
    });
    prisma.plotSite.findMany.mockResolvedValue([{ id: 30, name: 'Plot 30', isActive: true }]);
    prisma.pickupLocation.findMany.mockResolvedValue([{ id: 4, name: 'North Gate', isActive: true }]);
    prisma.contact.findMany.mockResolvedValue([{ id: 61, name: 'Priya Shah' }]);
    prisma.transportPerson.update.mockResolvedValue({
      id: 41, userId: 3, tenantId: 7, notes: 'Call first', customerIdsJson: '[61]', plotSiteIdsJson: '[30]',
      pickupLocationIdsJson: '[4]', assignmentPairsJson: '[{"customerId":61,"plotSiteId":30}]',
      assignmentStatusJson: '{"customer-61-plot-30":{"status":"ACCEPTED"}}', isActive: true,
    });

    const response = await request(makeApp({ role: 'USER' }))
      .put('/api/pickup-plot-inventory/people/me')
      .send({ roleType: 'transport', notes: 'Call first', plotSiteIds: [30], pickupLocationIds: [4] });

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(prisma.transportPerson.update).toHaveBeenCalledWith({
      where: { id: 41 },
      data: expect.objectContaining({ notes: 'Call first' }),
    });
    expect(response.body.assignments).toEqual([
      expect.objectContaining({ customerId: 61 }),
    ]);
  });

  test.each([
    { roleType: 'transport', modelName: 'transportPerson', profileId: 41 },
    { roleType: 'broker', modelName: 'plotBroker', profileId: 51 },
    { roleType: 'billing', modelName: 'billingPerson', profileId: 71 },
  ])('prevents $roleType staff from changing a customer plot mapping', async ({ roleType, modelName, profileId }) => {
    prisma.transportPerson.findFirst.mockResolvedValue(roleType === 'transport' ? {
      id: profileId, userId: 3, tenantId: 7, customerIdsJson: '[61]', plotSiteIdsJson: '[30]',
      assignmentPairsJson: '[{"customerId":61,"plotSiteId":30}]', isActive: true,
    } : null);
    prisma.plotBroker.findFirst.mockResolvedValue(roleType === 'broker' ? {
      id: profileId, userId: 3, tenantId: 7, customerIdsJson: '[61]', plotSiteIdsJson: '[30]',
      assignmentPairsJson: '[{"customerId":61,"plotSiteId":30}]', isActive: true,
    } : null);
    prisma.billingPerson.findFirst.mockResolvedValue(roleType === 'billing' ? {
      id: profileId, userId: 3, tenantId: 7, customerIdsJson: '[61]', plotSiteIdsJson: '[30]',
      assignmentPairsJson: '[{"customerId":61,"plotSiteId":30}]', isActive: true,
    } : null);

    const response = await request(makeApp({ role: 'USER' }))
      .put('/api/pickup-plot-inventory/people/me')
      .send({ roleType, assignments: [{ customerId: 61, plotSiteId: 31 }] });

    expect(response.status).toBe(403);
    expect(response.body.code).toBe('CUSTOMER_ASSIGNMENTS_ADMIN_ONLY');
    expect(prisma[modelName].update).not.toHaveBeenCalled();
  });

  test('rejects attempts to add another customer to a self-service assignment', async () => {
    prisma.transportPerson.findFirst.mockResolvedValue(null);
    prisma.billingPerson.findFirst.mockResolvedValue(null);
    prisma.plotBroker.findFirst.mockResolvedValue({
      id: 51, userId: 3, tenantId: 7, customerIdsJson: '[61]', plotSiteIdsJson: '[30]',
      assignmentPairsJson: '[{"customerId":61,"plotSiteId":30}]', isActive: true,
    });

    const response = await request(makeApp({ role: 'USER' }))
      .put('/api/pickup-plot-inventory/people/me')
      .send({
        roleType: 'broker', agency: 'Prime Realty',
        assignments: [{ customerId: 61, plotSiteId: 30 }, { customerId: 62, plotSiteId: 31 }],
      });

    expect(response.status).toBe(403);
    expect(response.body.code).toBe('CUSTOMER_ASSIGNMENTS_ADMIN_ONLY');
    expect(prisma.plotBroker.update).not.toHaveBeenCalled();
  });
});

describe('transport person mutations', () => {
  const vehicleDetails = { vehicleType: 'Mini truck', vehicleNumber: 'KA 01 AB 1234' };

  test('removes fully completed customers from assignment choices and existing person rows', async () => {
    prisma.customerPickup.findMany.mockResolvedValue([
      { contact: { id: 61, name: 'Completed Customer', phone: '9000011111' } },
      { contact: { id: 62, name: 'Active Customer', phone: '9000022222' } },
    ]);
    prisma.plotBooking.findMany.mockResolvedValue([{ contactId: 61 }]);
    prisma.transportPerson.findMany.mockResolvedValue([{
      id: 41, name: 'Ravi', phone: '9000033333', isActive: true,
      customerIdsJson: '[61,62]', plotSiteIdsJson: '[30,31]',
      assignmentPairsJson: '[{"customerId":61,"plotSiteId":30},{"customerId":62,"plotSiteId":31}]',
    }]);

    const response = await request(makeApp()).get('/api/pickup-plot-inventory/transport-persons');

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.customers).toEqual([expect.objectContaining({ id: 62, name: 'Active Customer' })]);
    expect(response.body.transportPersons[0].customerIds).toEqual([62]);
    expect(response.body.transportPersons[0].assignments).toEqual([{ customerId: 62, plotSiteId: 31 }]);
    expect(JSON.stringify(response.body)).not.toContain('Completed Customer');
  });

  test.each([
    ['transport-persons', { name: 'Driver', phone: '9000011111', plotSiteIds: [30], customerIds: [61], assignments: [{ customerId: 61, plotSiteId: 30 }] }],
    ['brokers', { name: 'Broker', phone: '9000011111', plotSiteIds: [30], customerIds: [61], assignments: [{ customerId: 61, plotSiteId: 30 }] }],
    ['billing-persons', { name: 'Billing', phone: '9000011111', plotSiteIds: [30], customerIds: [61], assignments: [{ customerId: 61, plotSiteId: 30 }] }],
  ])('rejects assigning a completed customer through %s', async (resource, payload) => {
    prisma.plotSite.findMany.mockResolvedValue([{ id: 30 }]);
    prisma.contact.findMany.mockResolvedValue([{ id: 61 }]);
    prisma.plotBooking.findMany.mockResolvedValue([{ contactId: 61 }]);

    const response = await request(makeApp())
      .post(`/api/pickup-plot-inventory/${resource}`)
      .send(payload);

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ code: 'INVALID_CUSTOMER', error: 'A completed customer cannot be assigned again.' });
  });

  test('returns only the signed-in transport person assignments', async () => {
    prisma.transportPerson.findFirst.mockResolvedValue({
      id: 41, userId: 3, tenantId: 7, name: 'Sant', phone: '9000011111',
      vehicleType: 'SUV', vehicleNumber: 'KA 01 AB 1234', pickupLocationId: 4,
      pickupLocationIdsJson: '[4]', plotSiteIdsJson: '[30]', customerIdsJson: '[61]',
      assignmentStatusJson: null, isActive: true,
    });
    prisma.pickupLocation.findMany.mockResolvedValue([{ id: 4, name: 'North Gate', address: 'MG Road' }]);
    prisma.plotSite.findMany.mockResolvedValue([{ id: 30, name: 'Green Acres', address: 'Airport Road' }]);
    prisma.contact.findMany.mockResolvedValue([{ id: 61, name: 'Priya Shah', phone: '9000022222' }]);

    const response = await request(makeApp({ role: 'USER' })).get('/api/pickup-plot-inventory/transport-persons/me');

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(prisma.transportPerson.findFirst).toHaveBeenCalledWith({
      where: { tenantId: 7, userId: 3, isActive: true },
    });
    expect(response.body.assignments).toEqual([expect.objectContaining({
      assignmentKey: 'customer-61-plot-30', status: 'ASSIGNED',
      customer: expect.objectContaining({ name: 'Priya Shah' }),
      pickup: expect.objectContaining({ name: 'North Gate' }),
      drop: expect.objectContaining({ name: 'Green Acres' }),
    })]);
    expect(response.body.summary).toEqual({ total: 1, active: 1, completed: 0 });
  });

  test('hides assignments whose customer has been deleted', async () => {
    prisma.transportPerson.findFirst.mockResolvedValue({
      id: 41, userId: 3, tenantId: 7, name: 'Sant', phone: '9000011111',
      pickupLocationIdsJson: '[4]', plotSiteIdsJson: '[30]', customerIdsJson: '[61]',
      assignmentStatusJson: null, isActive: true,
    });
    prisma.pickupLocation.findMany.mockResolvedValue([{ id: 4, name: 'North Gate', address: 'MG Road' }]);
    prisma.plotSite.findMany.mockResolvedValue([{ id: 30, name: 'Green Acres', address: 'Airport Road' }]);
    // Soft-deleted contacts are excluded by the live-contact query.
    prisma.contact.findMany.mockResolvedValue([]);

    const response = await request(makeApp({ role: 'USER' })).get('/api/pickup-plot-inventory/transport-persons/me');

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(prisma.contact.findMany).toHaveBeenCalledWith({
      where: { tenantId: 7, id: { in: [61] }, deletedAt: null },
      select: { id: true, name: true, phone: true, email: true, company: true },
    });
    expect(response.body.assignments).toEqual([]);
    expect(response.body.summary).toEqual({ total: 0, active: 0, completed: 0 });
  });

  test('hides transport assignments whose plot is inactive or missing', async () => {
    prisma.transportPerson.findFirst.mockResolvedValue({
      id: 41, userId: 3, tenantId: 7, name: 'Sant', phone: '9000011111',
      pickupLocationIdsJson: '[4]', plotSiteIdsJson: '[30]', customerIdsJson: '[61]',
      assignmentStatusJson: null, isActive: true,
    });
    prisma.contact.findMany.mockResolvedValue([{ id: 61, name: 'Priya Shah' }]);
    prisma.plotSite.findMany.mockResolvedValue([]);

    const response = await request(makeApp({ role: 'USER' })).get('/api/pickup-plot-inventory/transport-persons/me');

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(prisma.plotSite.findMany).toHaveBeenCalledWith({
      where: { tenantId: 7, id: { in: [30] }, isActive: true },
      select: { id: true, name: true, address: true, referenceCode: true },
    });
    expect(response.body.assignments).toEqual([]);
    expect(response.body.summary).toEqual({ total: 0, active: 0, completed: 0 });
  });

  test('rejects a stale driver update without overwriting another assignment', async () => {
    prisma.transportPerson.findFirst.mockResolvedValue({
      id: 41, userId: 3, tenantId: 7, customerIdsJson: '[61]', plotSiteIdsJson: '[30]',
      assignmentPairsJson: '[{"customerId":61,"plotSiteId":30}]', assignmentStatusJson: null,
      updatedAt: new Date('2026-10-07T00:00:00Z'), isActive: true,
    });
    prisma.transportPerson.updateMany.mockResolvedValueOnce({ count: 0 });

    const response = await request(makeApp({ role: 'USER' }))
      .patch('/api/pickup-plot-inventory/transport-persons/me/assignments/customer-61-plot-30/status')
      .send({ status: 'ACCEPTED' });

    expect(response.status).toBe(409);
    expect(response.body.code).toBe('WORKFLOW_CONFLICT');
    expect(prisma.transportPerson.updateMany.mock.calls[0][0].where).toMatchObject({
      id: 41, tenantId: 7, assignmentStatusJson: null, updatedAt: expect.any(Date),
    });
  });

  test('advances only the signed-in driver assignment to the next status', async () => {
    prisma.transportPerson.findFirst.mockResolvedValue({
      id: 41, userId: 3, tenantId: 7, pickupLocationId: 4,
      pickupLocationIdsJson: '[4]', plotSiteIdsJson: '[30]', customerIdsJson: '[61]',
      assignmentStatusJson: '{"customer-61-plot-30":{"status":"ACCEPTED","updatedAt":"2026-10-06T10:00:00.000Z"}}',
      isActive: true,
    });
    prisma.transportPerson.update.mockResolvedValue({ id: 41 });

    const response = await request(makeApp({ role: 'USER' }))
      .patch('/api/pickup-plot-inventory/transport-persons/me/assignments/customer-61-plot-30/status')
      .send({ status: 'HEADING_TO_PICKUP' });

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body).toMatchObject({ assignmentKey: 'customer-61-plot-30', status: 'HEADING_TO_PICKUP' });
    const update = prisma.transportPerson.updateMany.mock.calls[0][0];
    expect(update.where).toMatchObject({ id: 41, tenantId: 7 });
    expect(JSON.parse(update.data.assignmentStatusJson)['customer-61-plot-30'].status).toBe('HEADING_TO_PICKUP');
  });

  test('records pickup and drop-off times on the shared transport assignment', async () => {
    const pickupAt = '2026-10-26T08:30:00.000Z';
    prisma.transportPerson.findFirst
      .mockResolvedValueOnce({
        id: 41, userId: 3, tenantId: 7, customerIdsJson: '[61]', plotSiteIdsJson: '[30]',
        assignmentPairsJson: '[{"customerId":61,"plotSiteId":30}]',
        assignmentStatusJson: '{"customer-61-plot-30":{"status":"ARRIVED_AT_PICKUP"}}', isActive: true,
      })
      .mockResolvedValueOnce({
        id: 41, userId: 3, tenantId: 7, customerIdsJson: '[61]', plotSiteIdsJson: '[30]',
        assignmentPairsJson: '[{"customerId":61,"plotSiteId":30}]',
        assignmentStatusJson: JSON.stringify({
          'customer-61-plot-30': { status: 'ARRIVED_AT_DROP', pickupAt },
        }),
        isActive: true,
      });

    const pickedUp = await request(makeApp({ role: 'USER' }))
      .patch('/api/pickup-plot-inventory/transport-persons/me/assignments/customer-61-plot-30/status')
      .send({ status: 'PICKED_UP' });
    const completed = await request(makeApp({ role: 'USER' }))
      .patch('/api/pickup-plot-inventory/transport-persons/me/assignments/customer-61-plot-30/status')
      .send({ status: 'COMPLETED' });

    expect(pickedUp.status, JSON.stringify(pickedUp.body)).toBe(200);
    expect(pickedUp.body.pickupAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(pickedUp.body.dropOffAt).toBeNull();
    expect(completed.status, JSON.stringify(completed.body)).toBe(200);
    expect(completed.body.pickupAt).toBe(pickupAt);
    expect(completed.body.dropOffAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    const saved = JSON.parse(prisma.transportPerson.updateMany.mock.calls[1][0].data.assignmentStatusJson)['customer-61-plot-30'];
    expect(saved).toMatchObject({ status: 'COMPLETED', pickupAt, dropOffAt: completed.body.dropOffAt });
  });

  test('schedules pickup and drop-off times from the transport trip card', async () => {
    const scheduledPickupAt = new Date(Date.now() + 86_400_000).toISOString();
    const scheduledDropOffAt = new Date(Date.now() + 90_000_000).toISOString();
    prisma.transportPerson.findFirst.mockResolvedValue({
      id: 41, userId: 3, tenantId: 7, customerIdsJson: '[61]', plotSiteIdsJson: '[30]',
      assignmentPairsJson: '[{"customerId":61,"plotSiteId":30}]',
      assignmentStatusJson: '{"customer-61-plot-30":{"status":"ASSIGNED"}}', isActive: true,
    });

    const response = await request(makeApp({ role: 'USER' }))
      .patch('/api/pickup-plot-inventory/transport-persons/me/assignments/customer-61-plot-30/schedule')
      .send({ scheduledPickupAt, scheduledDropOffAt });

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body).toMatchObject({
      assignmentKey: 'customer-61-plot-30',
      scheduledPickupAt,
      scheduledDropOffAt,
    });
    const saved = JSON.parse(prisma.transportPerson.updateMany.mock.calls[0][0].data.assignmentStatusJson)['customer-61-plot-30'];
    expect(saved).toMatchObject({
      status: 'ASSIGNED',
      scheduledPickupAt,
      scheduledDropOffAt,
    });
    expect(audit.writeAudit).toHaveBeenCalledWith(
      'TransportPerson', 'SCHEDULE_TRIP', '41', 3, 7,
      expect.objectContaining({ assignmentKey: 'customer-61-plot-30' }),
    );
  });

  test.each(['both', 'pickup only', 'drop-off only'])('rejects drop-off before pickup when updating %s', async mode => {
    const earlier = new Date(Date.now() + 86_400_000).toISOString();
    const later = new Date(Date.now() + 90_000_000).toISOString();
    const saved = { status: 'ASSIGNED' };
    const body = {};
    if (mode === 'pickup only') saved.scheduledDropOffAt = earlier;
    else body.scheduledDropOffAt = earlier;
    if (mode === 'drop-off only') saved.scheduledPickupAt = later;
    else body.scheduledPickupAt = later;
    prisma.transportPerson.findFirst.mockResolvedValue({
      id: 41, userId: 3, tenantId: 7, customerIdsJson: '[61]', plotSiteIdsJson: '[30]',
      assignmentPairsJson: '[{"customerId":61,"plotSiteId":30}]',
      assignmentStatusJson: JSON.stringify({ 'customer-61-plot-30': saved }), isActive: true,
    });
    const response = await request(makeApp({ role: 'USER' }))
      .patch('/api/pickup-plot-inventory/transport-persons/me/assignments/customer-61-plot-30/schedule')
      .send(body);
    expect(response.status).toBe(400);
    expect(response.body.code).toBe('INVALID_TRANSPORT_SCHEDULE_ORDER');
    expect(prisma.transportPerson.updateMany).not.toHaveBeenCalled();
  });

  test('preserves an existing pickup when saving a later drop-off independently', async () => {
    const scheduledPickupAt = new Date(Date.now() + 86_400_000).toISOString();
    const scheduledDropOffAt = new Date(Date.now() + 90_000_000).toISOString();
    prisma.transportPerson.findFirst.mockResolvedValue({
      id: 41, userId: 3, tenantId: 7, customerIdsJson: '[61]', plotSiteIdsJson: '[30]',
      assignmentPairsJson: '[{"customerId":61,"plotSiteId":30}]',
      assignmentStatusJson: JSON.stringify({ 'customer-61-plot-30': { status: 'ASSIGNED', scheduledPickupAt } }), isActive: true,
    });
    const response = await request(makeApp({ role: 'USER' }))
      .patch('/api/pickup-plot-inventory/transport-persons/me/assignments/customer-61-plot-30/schedule')
      .send({ scheduledDropOffAt });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ scheduledPickupAt, scheduledDropOffAt });
  });

  test('rejects a past time without changing the independently saved pickup time', async () => {
    const scheduledPickupAt = new Date(Date.now() + 86_400_000).toISOString();
    const pastDropOffAt = new Date(Date.now() - 86_400_000).toISOString();
    prisma.transportPerson.findFirst.mockResolvedValue({
      id: 41, userId: 3, tenantId: 7, customerIdsJson: '[61]', plotSiteIdsJson: '[30]',
      assignmentPairsJson: '[{"customerId":61,"plotSiteId":30}]',
      assignmentStatusJson: JSON.stringify({
        'customer-61-plot-30': { status: 'ASSIGNED', scheduledPickupAt },
      }),
      isActive: true,
    });

    const response = await request(makeApp({ role: 'USER' }))
      .patch('/api/pickup-plot-inventory/transport-persons/me/assignments/customer-61-plot-30/schedule')
      .send({ scheduledDropOffAt: pastDropOffAt });

    expect(response.status).toBe(400);
    expect(response.body.code).toBe('TRANSPORT_SCHEDULE_IN_PAST');
    expect(prisma.transportPerson.updateMany).not.toHaveBeenCalled();
  });

  test('claims a customer when the first transport person accepts and removes it from peers', async () => {
    prisma.transportPerson.findFirst.mockResolvedValue({
      id: 41, userId: 3, tenantId: 7, pickupLocationIdsJson: '[4]',
      customerIdsJson: '[61]', plotSiteIdsJson: '[30]',
      assignmentPairsJson: '[{"customerId":61,"plotSiteId":30}]', assignmentStatusJson: null, isActive: true,
    });
    prisma.transportPerson.findMany.mockResolvedValue([{
      id: 42, tenantId: 7, customerIdsJson: '[61,62]', plotSiteIdsJson: '[30,31]',
      assignmentPairsJson: '[{"customerId":61,"plotSiteId":30},{"customerId":62,"plotSiteId":31}]',
      assignmentStatusJson: '{"customer-61-plot-30":{"status":"ASSIGNED"}}', isActive: true,
    }]);

    const response = await request(makeApp({ role: 'USER' }))
      .patch('/api/pickup-plot-inventory/transport-persons/me/assignments/customer-61-plot-30/status')
      .send({ status: 'ACCEPTED' });

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(prisma.transportPerson.update).toHaveBeenCalledWith({
      where: { id: 42 },
      data: {
        customerIdsJson: '[62]',
        assignmentPairsJson: '[{"customerId":62,"plotSiteId":31}]',
        assignmentStatusJson: null,
      },
    });
    expect(prisma.transportPerson.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: 41, tenantId: 7 }),
    }));
  });

  test('does not let a transport person claim work already started by a peer', async () => {
    prisma.transportPerson.findFirst.mockResolvedValue({
      id: 41, userId: 3, tenantId: 7, customerIdsJson: '[61]', plotSiteIdsJson: '[30]',
      assignmentPairsJson: '[{"customerId":61,"plotSiteId":30}]', assignmentStatusJson: null, isActive: true,
    });
    prisma.transportPerson.findMany.mockResolvedValue([{
      id: 42, tenantId: 7, customerIdsJson: '[61]', plotSiteIdsJson: '[30]',
      assignmentPairsJson: '[{"customerId":61,"plotSiteId":30}]',
      assignmentStatusJson: '{"customer-61-plot-30":{"status":"ACCEPTED"}}', isActive: true,
    }]);

    const response = await request(makeApp({ role: 'USER' }))
      .patch('/api/pickup-plot-inventory/transport-persons/me/assignments/customer-61-plot-30/status')
      .send({ status: 'ACCEPTED' });

    expect(response.status).toBe(409);
    expect(response.body.code).toBe('CUSTOMER_ALREADY_CLAIMED');
    expect(prisma.transportPerson.update).not.toHaveBeenCalled();
  });

  test('uses the customer transcript address as the assigned trip pickup', async () => {
    prisma.transportPerson.findFirst.mockResolvedValue({
      id: 41, userId: 3, tenantId: 7, name: 'Sant', phone: '9000011111',
      pickupLocationIdsJson: null, plotSiteIdsJson: '[30]', customerIdsJson: '[61]',
      assignmentStatusJson: null, isActive: true,
    });
    prisma.plotSite.findMany.mockResolvedValue([{ id: 30, name: 'Green Acres', address: 'Airport Road' }]);
    prisma.contact.findMany.mockResolvedValue([{ id: 61, name: 'Priya Shah', phone: '9000022222' }]);
    prisma.customerPickup.findMany.mockResolvedValue([{ id: 91, contactId: 61, pickupAddress: '42 Lake View Road, Bengaluru' }]);

    const response = await request(makeApp({ role: 'USER' })).get('/api/pickup-plot-inventory/transport-persons/me');

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.assignments[0].pickup).toEqual(expect.objectContaining({
      name: 'Customer pickup', address: '42 Lake View Road, Bengaluru', source: 'CALLIFIED_TRANSCRIPT',
    }));
  });

  test('rejects a driver status jump', async () => {
    prisma.transportPerson.findFirst.mockResolvedValue({
      id: 41, userId: 3, tenantId: 7, customerIdsJson: '[61]', plotSiteIdsJson: '[30]', assignmentStatusJson: null, isActive: true,
    });
    const response = await request(makeApp({ role: 'USER' }))
      .patch('/api/pickup-plot-inventory/transport-persons/me/assignments/customer-61-plot-30/status')
      .send({ status: 'COMPLETED' });
    expect(response.status).toBe(409);
    expect(response.body.code).toBe('INVALID_TRANSPORT_STATUS_TRANSITION');
    expect(prisma.transportPerson.update).not.toHaveBeenCalled();
  });

  test('creates a transport person with tenant-owned locations, plots, customers, and service areas', async () => {
    prisma.pickupLocation.findMany.mockResolvedValue([{ id: 4 }, { id: 5 }]);
    prisma.plotSite.findMany.mockResolvedValue([{ id: 30 }, { id: 31 }]);
    prisma.contact.findMany.mockResolvedValue([{ id: 61 }, { id: 62 }]);
    prisma.transportPerson.create.mockResolvedValue({
      id: 41, name: 'Ravi', phone: '9000011111', pickupLocationId: 4,
      pickupLocationIdsJson: '[4,5]', plotSiteIdsJson: '[30,31]',
      customerIdsJson: '[61,62]',
      serviceAreasJson: '[{"area":"Koramangala","state":"Karnataka","pincode":"560095"}]',
    });
    const response = await request(makeApp()).post('/api/pickup-plot-inventory/transport-persons').send({
      name: ' Ravi ', phone: ' 9000011111 ', vehicleType: 'Mini truck', vehicleNumber: 'KA 01 AB 1234',
      pickupLocationIds: [4, 5], plotSiteIds: [30, 31], customerIds: [61, 62],
      serviceAreas: [{ area: 'Koramangala', state: 'Karnataka', pincode: '560095' }],
    });
    expect(response.status).toBe(201);
    expect(prisma.pickupLocation.findMany).toHaveBeenCalledWith({ where: { id: { in: [4, 5] }, tenantId: 7 }, select: { id: true } });
    expect(prisma.plotSite.findMany).toHaveBeenCalledWith({ where: { id: { in: [30, 31] }, tenantId: 7 }, select: { id: true } });
    expect(prisma.contact.findMany).toHaveBeenCalledWith({ where: { id: { in: [61, 62] }, tenantId: 7 }, select: { id: true } });
    expect(prisma.transportPerson.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({
      name: 'Ravi', phone: '9000011111', pickupLocationId: 4,
      pickupLocationIdsJson: '[4,5]', plotSiteIdsJson: '[30,31]', customerIdsJson: '[61,62]', tenantId: 7,
      assignmentPairsJson: '[{"customerId":61,"plotSiteId":30},{"customerId":62,"plotSiteId":31}]',
    }) }));
    expect(response.body).toMatchObject({ pickupLocationIds: [4, 5], plotSiteIds: [30, 31], customerIds: [61, 62] });
    expect(response.body.serviceAreas).toEqual([{ area: 'Koramangala', state: 'Karnataka', pincode: '560095' }]);
    expect(assignmentWhatsApp.safeNotifyCustomerPickupPlotAssignments).toHaveBeenCalledWith({
      tenantId: 7,
      person: expect.objectContaining({ id: 41, phone: '9000011111' }),
    });
  });

  test('rejects a transport assignment whose plot was cancelled while the request waited', async () => {
    prisma.plotSite.findMany.mockResolvedValue([{ id: 30 }]);
    prisma.contact.findMany.mockResolvedValue([{ id: 61 }]);
    prisma.plotBooking.findMany.mockResolvedValueOnce([]).mockResolvedValue([{ status: 'CANCELLED' }]);
    const response = await request(makeApp()).post('/api/pickup-plot-inventory/transport-persons').send({
      ...vehicleDetails, name: 'Ravi Kumar', phone: '9000011111', plotSiteIds: [30], customerIds: [61],
    });
    expect(response.status, JSON.stringify(response.body)).toBe(409);
    expect(response.body.code).toBe('PLOT_ASSIGNMENT_REMOVED');
    expect(prisma.$queryRaw).toHaveBeenCalled();
    expect(prisma.transportPerson.create).not.toHaveBeenCalled();
  });

  test('allows transport assignment after a cancelled plot is assigned again', async () => {
    prisma.plotSite.findMany.mockResolvedValue([{ id: 30 }]);
    prisma.contact.findMany.mockResolvedValue([{ id: 61 }]);
    prisma.plotBooking.findMany.mockResolvedValueOnce([]).mockResolvedValue([{ status: 'CANCELLED' }, { status: 'PLOT_ASSIGNED' }]);
    prisma.transportPerson.create.mockResolvedValue({ id: 41, name: 'Ravi Kumar', phone: '9000011111' });
    const response = await request(makeApp()).post('/api/pickup-plot-inventory/transport-persons').send({
      ...vehicleDetails, name: 'Ravi Kumar', phone: '9000011111', plotSiteIds: [30], customerIds: [61],
    });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
  });

  test('rejects adding a cancelled plot when editing a transport person', async () => {
    prisma.transportPerson.findFirst.mockResolvedValue({ id: 41, tenantId: 7, isActive: true });
    prisma.plotSite.findMany.mockResolvedValue([{ id: 30 }]);
    prisma.contact.findMany.mockResolvedValue([{ id: 61 }]);
    prisma.plotBooking.findMany.mockResolvedValueOnce([]).mockResolvedValue([{ status: 'CANCELLED' }]);
    const response = await request(makeApp()).put('/api/pickup-plot-inventory/transport-persons/41').send({
      ...vehicleDetails, name: 'Ravi Kumar', phone: '9000011111', plotSiteIds: [30], customerIds: [61],
    });
    expect(response.status, JSON.stringify(response.body)).toBe(409);
    expect(response.body.code).toBe('PLOT_ASSIGNMENT_REMOVED');
    expect(prisma.transportPerson.update).not.toHaveBeenCalled();
  });

  test('rejects an invalid phone number', async () => {
    const response = await request(makeApp()).post('/api/pickup-plot-inventory/transport-persons').send({
      name: 'Ravi Kumar', phone: '123',
    });
    expect(response.status).toBe(400);
    expect(response.body.error).toMatch(/7 to 15 digits/);
    expect(prisma.transportPerson.create).not.toHaveBeenCalled();
  });

  test.each([
    ['vehicleType', 'Vehicle type'],
    ['vehicleNumber', 'Vehicle number'],
  ])('rejects a blank required %s', async (field, label) => {
    const response = await request(makeApp()).post('/api/pickup-plot-inventory/transport-persons').send({
      name: 'Ravi Kumar', phone: '9000011111', ...vehicleDetails, [field]: '',
    });
    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ error: `${label} is required.`, code: 'VALIDATION_ERROR' });
    expect(prisma.transportPerson.create).not.toHaveBeenCalled();
  });

  test('creates a staff login with a role granted Transport Workspace access', async () => {
    prisma.role.findMany.mockResolvedValue([
      { id: 1, key: 'ADMIN', name: 'Admin', permissions: [{ module: 'transport_workspace', action: 'read' }] },
      { id: 3, key: 'USER', name: 'User', permissions: [{ module: 'transport_workspace', action: 'read' }] },
      { id: 8, key: 'TRANSPORT_PERSON', name: 'Transport person', permissions: [{ module: 'transport_workspace', action: 'read' }] },
    ]);
    prisma.user.findFirst.mockResolvedValue(null);
    prisma.user.create.mockResolvedValue({ id: 81 });
    prisma.userRole.create.mockResolvedValue({ id: 91 });
    prisma.transportPerson.create.mockResolvedValue({
      id: 41, userId: 81, name: 'Ravi Kumar', phone: '9000011111',
      user: { id: 81, name: 'Ravi Kumar', email: 'ravi@example.com', phone: '9000011111' },
    });

    const response = await request(makeApp()).post('/api/pickup-plot-inventory/transport-persons').send({
      ...vehicleDetails, name: 'Ravi Kumar', phone: '9000011111', email: 'ravi@example.com', password: 'Secret123',
    });

    expect(response.status).toBe(201);
    expect(prisma.user.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        email: 'ravi@example.com', role: 'USER', userType: 'STAFF', tenantId: 7,
      }),
    }));
    expect(prisma.user.create.mock.calls[0][0].data.password).not.toBe('Secret123');
    expect(prisma.userRole.create).toHaveBeenCalledWith({
      data: { userId: 81, roleId: 8, assignedById: 3 },
    });
    expect(prisma.transportPerson.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ userId: 81, tenantId: 7 }),
    }));
  });

  test('links an existing staff member whose role has Transport Workspace access', async () => {
    prisma.user.findFirst.mockResolvedValue({
      id: 82, tenantId: 7, userRoles: [{ role: { id: 8, key: 'FIELD_TEAM', name: 'Field Team', permissions: [{ module: 'transport_workspace', action: 'read' }] } }],
    });
    prisma.transportPerson.findFirst.mockResolvedValue(null);
    prisma.transportPerson.create.mockResolvedValue({ id: 42, userId: 82, name: 'Mohan Das', phone: '9000022222' });

    const response = await request(makeApp()).post('/api/pickup-plot-inventory/transport-persons').send({
      ...vehicleDetails, name: 'Mohan Das', phone: '9000022222', staffUserId: 82,
    });

    expect(response.status).toBe(201);
    expect(prisma.user.create).not.toHaveBeenCalled();
    expect(prisma.transportPerson.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ userId: 82, tenantId: 7 }),
    }));
  });

  test('allows plots and customers already assigned to another transport person', async () => {
    prisma.plotSite.findMany.mockResolvedValue([{ id: 30 }]);
    prisma.contact.findMany.mockResolvedValue([{ id: 61 }]);
    prisma.transportPerson.findMany.mockResolvedValue([{
      id: 40, name: 'Amit Singh', plotSiteIdsJson: '[30]', customerIdsJson: '[61]',
    }]);
    prisma.transportPerson.create.mockResolvedValue({
      id: 41, name: 'Ravi Kumar', phone: '9000011111', plotSiteIdsJson: '[30]', customerIdsJson: '[61]',
    });

    const response = await request(makeApp()).post('/api/pickup-plot-inventory/transport-persons').send({
      ...vehicleDetails, name: 'Ravi Kumar', phone: '9000011111', plotSiteIds: [30], customerIds: [61],
    });
    expect(response.status).toBe(201);
    expect(prisma.transportPerson.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ plotSiteIdsJson: '[30]', customerIdsJson: '[61]' }),
    }));
  });

  test('allows an edited transport person to retain its own assignments', async () => {
    prisma.transportPerson.findFirst.mockResolvedValue({ id: 41, tenantId: 7, isActive: true });
    prisma.plotSite.findMany.mockResolvedValue([{ id: 30 }]);
    prisma.contact.findMany.mockResolvedValue([{ id: 61 }]);
    prisma.transportPerson.findMany.mockResolvedValue([{
      id: 41, name: 'Ravi Kumar', plotSiteIdsJson: '[30]', customerIdsJson: '[61]',
    }]);
    prisma.transportPerson.update.mockResolvedValue({
      id: 41, name: 'Ravi Kumar', phone: '9000011111', plotSiteIdsJson: '[30]', customerIdsJson: '[61]',
    });

    const response = await request(makeApp()).put('/api/pickup-plot-inventory/transport-persons/41').send({
      ...vehicleDetails, name: 'Ravi Kumar', phone: '9000011111', plotSiteIds: [30], customerIds: [61],
    });
    expect(response.status).toBe(200);
    expect(prisma.transportPerson.update).toHaveBeenCalled();
  });

  test('preserves completed transport assignments when the admin submits only visible active work', async () => {
    prisma.transportPerson.findFirst.mockResolvedValue({
      id: 41, tenantId: 7, isActive: true,
      customerIdsJson: '[61]', plotSiteIdsJson: '[30]',
      assignmentPairsJson: '[{"customerId":61,"plotSiteId":30}]',
      assignmentStatusJson: '{"customer-61-plot-30":{"status":"COMPLETED"}}',
    });
    prisma.plotSite.findMany.mockResolvedValue([{ id: 31 }]);
    prisma.contact.findMany.mockResolvedValue([{ id: 62 }]);
    prisma.transportPerson.update.mockResolvedValue({
      id: 41, name: 'Sant', phone: '9000011111',
      customerIdsJson: '[62,61]', plotSiteIdsJson: '[31,30]',
      assignmentPairsJson: '[{"customerId":62,"plotSiteId":31},{"customerId":61,"plotSiteId":30}]',
      assignmentStatusJson: '{"customer-61-plot-30":{"status":"COMPLETED"}}',
    });

    const response = await request(makeApp()).put('/api/pickup-plot-inventory/transport-persons/41').send({
      ...vehicleDetails, name: 'Sant', phone: '9000011111', plotSiteIds: [31], customerIds: [62],
      assignments: [{ customerId: 62, plotSiteId: 31 }],
    });

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(prisma.transportPerson.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        customerIdsJson: '[62,61]',
        plotSiteIdsJson: '[31,30]',
        assignmentPairsJson: '[{"customerId":62,"plotSiteId":31},{"customerId":61,"plotSiteId":30}]',
      }),
    }));
  });

  test('lists transport persons and pickup choices within the authenticated tenant', async () => {
    prisma.transportPerson.findMany.mockResolvedValue([{ id: 41, name: 'Ravi', isActive: true, pickupLocationId: 4 }]);
    prisma.pickupLocation.findMany.mockResolvedValue([{ id: 4, name: 'North Gate' }]);
    prisma.customerPickup.findMany.mockResolvedValue([{
      contact: { id: 61, name: 'Priya Lead', phone: '9000011111', status: 'Lead' },
    }]);
    const response = await request(makeApp()).get('/api/pickup-plot-inventory/transport-persons');
    expect(response.status).toBe(200);
    expect(response.body.summary).toEqual({ total: 1, active: 1, assigned: 0 });
    expect(response.body.customers).toEqual([
      expect.objectContaining({ id: 61, name: 'Priya Lead' }),
    ]);
    expect(prisma.transportPerson.findMany.mock.calls[0][0].where).toEqual({
      tenantId: 7,
      OR: [{ userId: null }, { user: { is: { deactivatedAt: null } } }],
    });
    expect(prisma.pickupLocation.findMany.mock.calls[0][0].where).toEqual({ tenantId: 7 });
    expect(prisma.customerPickup.findMany.mock.calls[0][0]).toEqual(expect.objectContaining({
      where: { tenantId: 7, contact: { deletedAt: null } },
    }));
  });

  test('maps confirmed customers to matching pickup locations and their assigned plot name', async () => {
    prisma.pickupLocation.findMany.mockResolvedValue([
      { id: 4, name: 'Bangalore Palace', address: 'Bangalore Palace, Jayamahal Road', isActive: true },
      { id: 5, name: 'South Gate', address: 'Brigade Road', isActive: true },
    ]);
    prisma.plotSite.findMany.mockResolvedValue([
      { id: 30, name: 'btm', plotNumber: '11', address: 'BTM Layout', availability: 'AVAILABLE', isActive: true },
    ]);
    prisma.customerPickup.findMany.mockResolvedValue([{
      pickupAddress: 'Bangalore Palace, Jayamahal Road, Bengaluru',
      contact: { id: 61, name: 'Priya Lead', phone: '9000011111', status: 'Lead' },
    }]);
    prisma.plotBooking.findMany.mockImplementation(({ where }) => Promise.resolve(
      where.status === 'PLOT_ASSIGNED' ? [{ contactId: 61, plotSiteId: 30 }] : [],
    ));

    const response = await request(makeApp()).get('/api/pickup-plot-inventory/transport-persons');

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.customers).toEqual([expect.objectContaining({
      id: 61,
      pickupLocationIds: [4],
      assignedPlotSiteId: 30,
      assignedPlotName: 'btm',
      assignedPlots: [expect.objectContaining({ id: 30, name: 'btm', plotNumber: '11' })],
    })]);
    expect(prisma.plotBooking.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { tenantId: 7, status: 'PLOT_ASSIGNED' },
    }));
  });

  test('removes deleted customers from saved transport assignments', async () => {
    prisma.transportPerson.findMany.mockResolvedValue([{
      id: 41, name: 'Ravi', phone: '9000011111', isActive: true,
      customerIdsJson: '[61,329]', plotSiteIdsJson: '[30]',
      assignmentPairsJson: '[{"customerId":61,"plotSiteId":30},{"customerId":329,"plotSiteId":30}]',
    }]);
    prisma.customerPickup.findMany.mockResolvedValue([{
      contact: { id: 61, name: 'Priya Lead', phone: '9000011111' },
    }]);

    const response = await request(makeApp()).get('/api/pickup-plot-inventory/transport-persons');

    expect(response.status).toBe(200);
    expect(response.body.transportPersons[0].customerIds).toEqual([61]);
    expect(response.body.transportPersons[0].assignments).toEqual([{ customerId: 61, plotSiteId: 30 }]);
    expect(JSON.stringify(response.body)).not.toContain('329');
  });

  test('lists unlinked staff whose role has Transport Workspace access', async () => {
    prisma.transportPerson.findMany.mockResolvedValue([{
      id: 41, name: 'Ravi Kumar', phone: '9000011111', userId: 81, isActive: true,
      user: { id: 81, name: 'Ravi Kumar', email: 'ravi@example.com', phone: '9000011111' },
    }]);
    prisma.role.findMany.mockResolvedValue([{ id: 8, key: 'FIELD_TEAM', name: 'Field Team', permissions: [{ module: 'transport_workspace', action: 'read' }] }]);
    prisma.user.findMany.mockResolvedValue([
      { id: 81, name: 'Ravi Kumar', email: 'ravi@example.com', phone: '9000011111' },
      { id: 82, name: 'Sant Kumar', email: 'sant@example.com', phone: '9000099999' },
    ]);

    const response = await request(makeApp()).get('/api/pickup-plot-inventory/transport-persons');

    expect(response.status).toBe(200);
    expect(response.body.transportRole).toMatchObject({ id: 8, name: 'Field Team' });
    expect(response.body.staffUsers).toEqual([
      { id: 82, name: 'Sant Kumar', email: 'sant@example.com', phone: '9000099999' },
    ]);
    expect(prisma.user.findMany.mock.calls[0][0].where).toMatchObject({
      tenantId: 7,
      userRoles: { some: { role: { permissions: { some: { module: 'transport_workspace', action: 'read' } } } } },
    });
  });

  test('keeps linked staff identity fields synchronized when a transport profile is edited', async () => {
    prisma.transportPerson.findFirst.mockResolvedValue({ id: 41, tenantId: 7, userId: 81, isActive: true });
    prisma.user.update.mockResolvedValue({ id: 81 });
    prisma.transportPerson.update.mockResolvedValue({
      id: 41, userId: 81, name: 'Ravi Kumar', phone: '9000011111',
      user: { id: 81, name: 'Ravi Kumar', email: 'ravi@example.com', phone: '9000011111' },
    });

    const response = await request(makeApp()).put('/api/pickup-plot-inventory/transport-persons/41').send({
      ...vehicleDetails, name: 'Ravi Kumar', phone: '9000011111', plotSiteIds: [], customerIds: [],
    });

    expect(response.status).toBe(200);
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: 81 }, data: { name: 'Ravi Kumar', phone: '9000011111' },
    });
  });
});

describe('plot broker mutations', () => {
  test('rejects assigning a transport customer already started by another driver', async () => {
    prisma.transportPerson.findFirst.mockResolvedValue({ id: 42, tenantId: 7, isActive: true });
    prisma.contact.findMany.mockResolvedValue([{ id: 61 }]);
    prisma.plotSite.findMany.mockResolvedValue([{ id: 30 }]);
    prisma.transportPerson.findMany.mockResolvedValue([{
      id: 41, customerIdsJson: '[61]', plotSiteIdsJson: '[30]',
      assignmentPairsJson: '[{"customerId":61,"plotSiteId":30}]',
      assignmentStatusJson: '{"customer-61-plot-30":{"status":"ACCEPTED"}}',
    }]);

    const response = await request(makeApp()).put('/api/pickup-plot-inventory/transport-persons/42').send({
      name: 'Raj Kumar', phone: '9000011111', customerIds: [61], plotSiteIds: [30],
      assignments: [{ customerId: 61, plotSiteId: 30 }],
    });

    expect(response.status).toBe(409);
    expect(response.body.code).toBe('CUSTOMER_ALREADY_CLAIMED');
    expect(prisma.transportPerson.update).not.toHaveBeenCalled();
  });

  test('rejects changing the plot after the transport trip has started', async () => {
    prisma.transportPerson.findFirst.mockResolvedValue({
      id: 41, tenantId: 7, isActive: true, customerIdsJson: '[61]', plotSiteIdsJson: '[30]',
      assignmentPairsJson: '[{"customerId":61,"plotSiteId":30}]',
      assignmentStatusJson: '{"customer-61-plot-30":{"status":"ACCEPTED"}}',
    });
    prisma.contact.findMany.mockResolvedValue([{ id: 61 }]);
    prisma.plotSite.findMany.mockResolvedValue([{ id: 30 }, { id: 31 }]);
    prisma.transportPerson.findMany.mockResolvedValue([{
      id: 41, customerIdsJson: '[61]', plotSiteIdsJson: '[30]',
      assignmentPairsJson: '[{"customerId":61,"plotSiteId":30}]',
      assignmentStatusJson: '{"customer-61-plot-30":{"status":"ACCEPTED"}}',
    }]);

    const response = await request(makeApp()).put('/api/pickup-plot-inventory/transport-persons/41').send({
      name: 'Sant Kumar', phone: '9000011111', customerIds: [61], plotSiteIds: [30, 31],
      assignments: [{ customerId: 61, plotSiteId: 31 }],
    });

    expect(response.status).toBe(409);
    expect(response.body.code).toBe('ASSIGNMENT_PLOT_LOCKED');
    expect(prisma.transportPerson.update).not.toHaveBeenCalled();
  });

  test('rejects assigning a broker customer already started by another broker', async () => {
    prisma.plotBroker.findFirst.mockResolvedValue({ id: 52, tenantId: 7, isActive: true });
    prisma.contact.findMany.mockResolvedValue([{ id: 61 }]);
    prisma.plotSite.findMany.mockResolvedValue([{ id: 30 }]);
    prisma.plotBroker.findMany.mockResolvedValue([{
      id: 51, customerIdsJson: '[61]', plotSiteIdsJson: '[30]',
      assignmentPairsJson: '[{"customerId":61,"plotSiteId":30}]',
      workflowStatusJson: '{"customer-61-plot-30":{"status":"EXPLANATION_STARTED"}}',
    }]);

    const response = await request(makeApp()).put('/api/pickup-plot-inventory/brokers/52').send({
      name: 'Asha Rao', phone: '9000022222', customerIds: [61], plotSiteIds: [30],
    });

    expect(response.status).toBe(409);
    expect(response.body.code).toBe('CUSTOMER_ALREADY_CLAIMED');
    expect(prisma.plotBroker.update).not.toHaveBeenCalled();
  });

  test('rejects assigning a billing customer already started by another billing person', async () => {
    prisma.billingPerson.findFirst.mockResolvedValue({ id: 72, tenantId: 7, isActive: true });
    prisma.contact.findMany.mockResolvedValue([{ id: 61 }]);
    prisma.plotSite.findMany.mockResolvedValue([{ id: 30 }]);
    prisma.plotBooking.findMany.mockImplementation(({ where }) => Promise.resolve(
      where.status === 'TRANSACTION_COMPLETED' ? [] : [{ contactId: 61, billingPersonId: 71 }],
    ));

    const response = await request(makeApp()).put('/api/pickup-plot-inventory/billing-persons/72').send({
      name: 'Ravi Billing', phone: '9000033333', email: 'ravi@example.com',
      customerIds: [61], plotSiteIds: [30],
    });

    expect(response.status).toBe(409);
    expect(response.body.code).toBe('CUSTOMER_ALREADY_CLAIMED');
    expect(prisma.billingPerson.update).not.toHaveBeenCalled();
  });

  test('uses the Transport-assigned plot for each broker customer', async () => {
    prisma.plotSite.findMany.mockResolvedValue([{ id: 30 }, { id: 31 }]);
    prisma.contact.findMany.mockResolvedValue([{ id: 61 }]);
    prisma.transportPerson.findMany.mockResolvedValue([{
      assignmentPairsJson: '[{"customerId":61,"plotSiteId":30}]',
    }]);
    prisma.plotBroker.create.mockResolvedValue({
      id: 51, name: 'Asha Rao', phone: '9000022222', plotSiteIdsJson: '[30,31]', customerIdsJson: '[61]',
    });

    const response = await request(makeApp()).post('/api/pickup-plot-inventory/brokers').send({
      name: 'Asha Rao', phone: '9000022222', plotSiteIds: [30, 31], customerIds: [61],
      assignments: [{ customerId: 61, plotSiteId: 31 }],
    });

    expect(response.status, JSON.stringify(response.body)).toBe(201);
    expect(prisma.plotBroker.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        plotSiteIdsJson: '[30,31]', customerIdsJson: '[61]',
        assignmentPairsJson: '[{"customerId":61,"plotSiteId":30}]',
      }),
    }));
  });

  test('uses the Transport-assigned plot for each billing customer', async () => {
    prisma.plotSite.findMany.mockResolvedValue([{ id: 30 }, { id: 31 }]);
    prisma.contact.findMany.mockResolvedValue([{ id: 61 }]);
    prisma.transportPerson.findMany.mockResolvedValue([{
      assignmentPairsJson: '[{"customerId":61,"plotSiteId":30}]',
    }]);
    prisma.billingPerson.findFirst.mockResolvedValue({ id: 71, userId: null, isActive: true });
    prisma.billingPerson.update.mockResolvedValue({
      id: 71, name: 'Bina Shah', phone: '9000011111', plotSiteIdsJson: '[30,31]', customerIdsJson: '[61]',
    });

    const response = await request(makeApp()).put('/api/pickup-plot-inventory/billing-persons/71').send({
      name: 'Bina Shah', phone: '9000011111', email: 'bina@example.com',
      plotSiteIds: [30, 31], customerIds: [61], assignments: [{ customerId: 61, plotSiteId: 31 }],
    });

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(prisma.billingPerson.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        plotSiteIdsJson: '[30,31]', customerIdsJson: '[61]',
        assignmentPairsJson: '[{"customerId":61,"plotSiteId":30}]',
      }),
    }));
  });

  test('lists every assigned broker customer but exposes only completed trip state', async () => {
    prisma.plotBroker.findFirst.mockResolvedValue({
      id: 51, userId: 3, tenantId: 7, name: 'Sanjeev', phone: '9000011111', agency: 'Prime Realty',
      commissionPercent: 2.5, customerIdsJson: '[61,62]', plotSiteIdsJson: '[30,31]',
      workflowStatusJson: null,
      isActive: true,
    });
    prisma.contact.findMany.mockResolvedValue([
      { id: 61, name: 'Li Wei', phone: '9000022222', company: 'Shenzhen Micro Ltd' },
      { id: 62, name: 'Priyanka Mehta', phone: '9000033333', company: 'Acme India' },
    ]);
    prisma.plotSite.findMany.mockResolvedValue([
      { id: 30, name: 'Plot 24', plotNumber: 'A-24', address: 'North Avenue', availability: 'AVAILABLE' },
      { id: 31, name: 'Plot 25', plotNumber: 'B-25', address: 'South Avenue', availability: 'AVAILABLE' },
    ]);
    prisma.transportPerson.findMany.mockResolvedValue([{
      customerIdsJson: '[61,62]', plotSiteIdsJson: '[30,31]',
      assignmentStatusJson: '{"customer-61":{"status":"COMPLETED","pickupAt":"2026-10-06T09:15:00.000Z","dropOffAt":"2026-10-06T10:00:00.000Z","updatedAt":"2026-10-06T10:00:00.000Z"},"customer-62":{"status":"PICKED_UP"}}',
    }]);

    const response = await request(makeApp({ role: 'USER' })).get('/api/pickup-plot-inventory/brokers/me');

    expect(response.status).toBe(200);
    expect(response.body.summary).toEqual({ total: 2, completed: 1, waiting: 1 });
    expect(response.body.customers).toEqual([
      expect.objectContaining({
        id: 61, tripCompleted: true, tripMessage: 'Trip completed', plot: expect.objectContaining({ id: 30 }),
        plotOptions: [expect.objectContaining({ id: 30, plotNumber: 'A-24' })],
        pickupAt: '2026-10-06T09:15:00.000Z', dropOffAt: '2026-10-06T10:00:00.000Z',
        brokerWorkflow: { status: 'VISIT_SCHEDULED', updatedAt: null, visitScheduledAt: '2026-10-06T10:00:00.000Z' },
      }),
      expect.objectContaining({ id: 62, tripCompleted: false, tripMessage: 'Trip not completed', plot: expect.objectContaining({ id: 31 }) }),
    ]);
    expect(response.body.customers[1]).not.toHaveProperty('status');
    expect(response.body.customers[1]).not.toHaveProperty('brokerWorkflow');
  });

  test('hides deleted customers from the Sales Executive workspace and its counts', async () => {
    prisma.plotBroker.findFirst.mockResolvedValue({
      id: 51, userId: 3, tenantId: 7, name: 'Sanjeev',
      assignmentPairsJson: '[{"customerId":61,"plotSiteId":30}]',
      workflowStatusJson: null, isActive: true,
    });
    prisma.contact.findMany.mockResolvedValue([]);

    const response = await request(makeApp({ role: 'USER' })).get('/api/pickup-plot-inventory/brokers/me');

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(prisma.contact.findMany).toHaveBeenCalledWith({
      where: { tenantId: 7, id: { in: [61] }, deletedAt: null },
      select: { id: true, name: true, phone: true, email: true, company: true },
    });
    expect(response.body.customers).toEqual([]);
    expect(response.body.summary).toEqual({ total: 0, completed: 0, waiting: 0 });
  });

  test('lists every plot assigned to a broker customer as a site-visit option', async () => {
    prisma.plotBroker.findFirst.mockResolvedValue({
      id: 51, userId: 3, tenantId: 7, name: 'Sanjeev',
      assignmentPairsJson: '[{"customerId":61,"plotSiteId":30}]',
      workflowStatusJson: '{"customer-61-plot-30":{"status":"PLOT_SHOWN"}}', isActive: true,
    });
    prisma.contact.findMany.mockResolvedValue([{ id: 61, name: 'Hariosh' }]);
    prisma.plotBooking.findMany.mockResolvedValue([
      { id: 91, contactId: 61, plotSiteId: 30 },
      { id: 92, contactId: 61, plotSiteId: 31 },
    ]);
    prisma.plotSite.findMany.mockResolvedValue([
      { id: 30, name: 'btm', plotNumber: '11', availability: 'AVAILABLE' },
      { id: 31, name: 'btm', plotNumber: '10', availability: 'AVAILABLE' },
    ]);
    prisma.transportPerson.findMany.mockResolvedValue([{
      id: 41,
      assignmentPairsJson: '[{"customerId":61,"plotSiteId":30}]',
      assignmentStatusJson: '{"customer-61-plot-30":{"status":"COMPLETED"}}',
    }]);

    const response = await request(makeApp({ role: 'USER' })).get('/api/pickup-plot-inventory/brokers/me');

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(prisma.plotBooking.findMany).toHaveBeenCalledWith({
      where: { tenantId: 7, contactId: { in: [61] }, status: 'PLOT_ASSIGNED' },
      select: { id: true, contactId: true, plotSiteId: true },
    });
    expect(response.body.customers[0].plotOptions).toEqual([
      expect.objectContaining({ id: 30, plotNumber: '11' }),
      expect.objectContaining({ id: 31, plotNumber: '10' }),
    ]);
  });

  test('advances a completed-trip customer through the broker workflow in order', async () => {
    prisma.plotBroker.findFirst.mockResolvedValue({
      id: 51, userId: 3, tenantId: 7, customerIdsJson: '[61]',
      plotSiteIdsJson: '[30]',
      workflowStatusJson: '{"customer-61":{"status":"VISIT_SCHEDULED"}}', isActive: true,
    });
    prisma.transportPerson.findMany.mockResolvedValue([{
      id: 41, customerIdsJson: '[61]', plotSiteIdsJson: '[30]', assignmentStatusJson: '{"customer-61":{"status":"COMPLETED"}}',
    }]);
    prisma.plotBroker.update.mockResolvedValue({ id: 51 });

    const response = await request(makeApp({ role: 'USER' }))
      .patch('/api/pickup-plot-inventory/brokers/me/customers/61/workflow')
      .send({ status: 'VISIT_CONFIRMED' });

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body).toMatchObject({ customerId: 61, status: 'VISIT_CONFIRMED' });
    const update = prisma.plotBroker.updateMany.mock.calls[0][0];
    expect(update.where).toMatchObject({ id: 51, tenantId: 7 });
    expect(JSON.parse(update.data.workflowStatusJson)['customer-61-plot-30'].status).toBe('VISIT_CONFIRMED');
  });

  test('uses the transport drop-off and allows the Sales Executive to mark the plot shown immediately', async () => {
    prisma.plotBroker.findFirst.mockResolvedValue({
      id: 51, userId: 3, tenantId: 7, customerIdsJson: '[61]', plotSiteIdsJson: '[30]',
      workflowStatusJson: null, isActive: true,
    });
    prisma.transportPerson.findMany.mockResolvedValue([{
      id: 41, customerIdsJson: '[61]', plotSiteIdsJson: '[30]',
      assignmentStatusJson: '{"customer-61":{"status":"COMPLETED","dropOffAt":"2026-10-06T10:00:00.000Z"}}',
    }]);

    const response = await request(makeApp({ role: 'USER' }))
      .patch('/api/pickup-plot-inventory/brokers/me/customers/61/workflow')
      .send({ status: 'PLOT_SHOWN' });

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body).toMatchObject({
      customerId: 61,
      status: 'PLOT_SHOWN',
      visitScheduledAt: '2026-10-06T10:00:00.000Z',
    });
    const savedStatus = JSON.parse(prisma.plotBroker.updateMany.mock.calls[0][0].data.workflowStatusJson);
    expect(savedStatus['customer-61-plot-30']).toMatchObject({
      status: 'PLOT_SHOWN',
      visitScheduledAt: '2026-10-06T10:00:00.000Z',
    });
  });

  test('rejects a stale Sales Executive workflow update', async () => {
    prisma.plotBroker.findFirst.mockResolvedValue({
      id: 51, userId: 3, tenantId: 7, customerIdsJson: '[61]', plotSiteIdsJson: '[30]',
      assignmentPairsJson: '[{"customerId":61,"plotSiteId":30}]',
      workflowStatusJson: '{"customer-61-plot-30":{"status":"VISIT_SCHEDULED"}}',
      updatedAt: new Date('2026-10-07T00:00:00Z'), isActive: true,
    });
    prisma.transportPerson.findMany.mockResolvedValue([{
      id: 41, customerIdsJson: '[61]', plotSiteIdsJson: '[30]',
      assignmentPairsJson: '[{"customerId":61,"plotSiteId":30}]',
      assignmentStatusJson: '{"customer-61-plot-30":{"status":"COMPLETED"}}',
    }]);
    prisma.plotBroker.updateMany.mockResolvedValueOnce({ count: 0 });

    const response = await request(makeApp({ role: 'USER' }))
      .patch('/api/pickup-plot-inventory/brokers/me/customers/61/workflow')
      .send({ status: 'VISIT_CONFIRMED' });

    expect(response.status).toBe(409);
    expect(response.body.code).toBe('WORKFLOW_CONFLICT');
  });

  test.each([
    ['VISIT_CONFIRMED', 'REMINDER_SENT'],
    ['REMINDER_SENT', 'ATTENDED'],
    ['REMINDER_SENT', 'NO_SHOW'],
    ['ATTENDED', 'PLOT_SHOWN'],
    ['VISIT_RESCHEDULED', 'VISIT_CONFIRMED'],
  ])('allows site visit transition %s to %s', async (currentStatus, nextStatus) => {
    prisma.plotBroker.findFirst.mockResolvedValue({
      id: 51, userId: 3, tenantId: 7, customerIdsJson: '[61]', plotSiteIdsJson: '[30]',
      workflowStatusJson: JSON.stringify({ 'customer-61': { status: currentStatus } }), isActive: true,
    });
    prisma.transportPerson.findMany.mockResolvedValue([{
      id: 41, customerIdsJson: '[61]', plotSiteIdsJson: '[30]', assignmentStatusJson: '{"customer-61":{"status":"COMPLETED"}}',
    }]);
    prisma.plotBroker.update.mockResolvedValue({ id: 51 });

    const response = await request(makeApp({ role: 'USER' }))
      .patch('/api/pickup-plot-inventory/brokers/me/customers/61/workflow')
      .send({ status: nextStatus });

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.status).toBe(nextStatus);
  });

  test('requires a visit date when scheduling or rescheduling', async () => {
    prisma.plotBroker.findFirst.mockResolvedValue({
      id: 51, userId: 3, tenantId: 7, customerIdsJson: '[61]', plotSiteIdsJson: '[30]',
      workflowStatusJson: null, isActive: true,
    });
    prisma.transportPerson.findMany.mockResolvedValue([{
      id: 41, customerIdsJson: '[61]', plotSiteIdsJson: '[30]', assignmentStatusJson: '{"customer-61":{"status":"COMPLETED"}}',
    }]);

    const response = await request(makeApp({ role: 'USER' }))
      .patch('/api/pickup-plot-inventory/brokers/me/customers/61/workflow')
      .send({ status: 'VISIT_SCHEDULED' });

    expect(response.status).toBe(400);
    expect(response.body.code).toBe('VISIT_SCHEDULE_REQUIRED');
  });

  test('claims a customer when the first broker starts and removes it from peer brokers', async () => {
    prisma.plotBroker.findFirst.mockResolvedValue({
      id: 51, userId: 3, tenantId: 7, customerIdsJson: '[61]', plotSiteIdsJson: '[30]',
      assignmentPairsJson: '[{"customerId":61,"plotSiteId":30}]', workflowStatusJson: null, isActive: true,
    });
    prisma.transportPerson.findMany.mockResolvedValue([{
      id: 41, customerIdsJson: '[61]', plotSiteIdsJson: '[30]',
      assignmentPairsJson: '[{"customerId":61,"plotSiteId":30}]',
      assignmentStatusJson: '{"customer-61-plot-30":{"status":"COMPLETED"}}',
    }]);
    prisma.plotBroker.findMany.mockResolvedValue([{
      id: 52, tenantId: 7, customerIdsJson: '[61,62]', plotSiteIdsJson: '[30,31]',
      assignmentPairsJson: '[{"customerId":61,"plotSiteId":30},{"customerId":62,"plotSiteId":31}]',
      workflowStatusJson: null, isActive: true,
    }]);

    const response = await request(makeApp({ role: 'USER' }))
      .patch('/api/pickup-plot-inventory/brokers/me/customers/61/workflow')
      .send({ status: 'VISIT_SCHEDULED', visitScheduledAt: '2026-10-07T10:00:00.000Z' });

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(prisma.plotBroker.update).toHaveBeenCalledWith({
      where: { id: 52 },
      data: {
        customerIdsJson: '[62]',
        assignmentPairsJson: '[{"customerId":62,"plotSiteId":31}]',
        workflowStatusJson: null,
      },
    });
    expect(prisma.plotBroker.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: 51, tenantId: 7 }),
    }));
  });

  test('does not start broker work before the customer trip is completed', async () => {
    prisma.plotBroker.findFirst.mockResolvedValue({
      id: 51, userId: 3, tenantId: 7, customerIdsJson: '[61]', workflowStatusJson: null, isActive: true,
    });
    prisma.transportPerson.findMany.mockResolvedValue([{
      customerIdsJson: '[61]', plotSiteIdsJson: '[30]', assignmentStatusJson: '{"customer-61":{"status":"PICKED_UP"}}',
    }]);

    const response = await request(makeApp({ role: 'USER' }))
      .patch('/api/pickup-plot-inventory/brokers/me/customers/61/workflow')
      .send({ status: 'VISIT_SCHEDULED', visitScheduledAt: '2026-10-07T10:00:00.000Z' });

    expect(response.status).toBe(409);
    expect(response.body.code).toBe('TRIP_NOT_COMPLETED');
    expect(prisma.plotBroker.update).not.toHaveBeenCalled();
  });

  test('hands an interested customer to the billing department', async () => {
    prisma.plotBroker.findFirst.mockResolvedValue({
      id: 51, userId: 3, tenantId: 7, customerIdsJson: '[61]',
      plotSiteIdsJson: '[30]',
      workflowStatusJson: '{"customer-61":{"status":"PLOT_SHOWN"}}', isActive: true,
    });
    prisma.transportPerson.findMany.mockResolvedValue([{
      id: 41, customerIdsJson: '[61]', plotSiteIdsJson: '[30]', assignmentStatusJson: '{"customer-61":{"status":"COMPLETED"}}',
    }]);
    prisma.plotBroker.update.mockResolvedValue({ id: 51 });
    prisma.plotSite.findFirst.mockResolvedValue({ id: 30, name: 'Plot 24', availability: 'AVAILABLE', isActive: true });
    prisma.plotSite.update.mockResolvedValue({ id: 30, availability: 'RESERVED' });

    const response = await request(makeApp({ role: 'USER' }))
      .patch('/api/pickup-plot-inventory/brokers/me/customers/61/workflow')
      .send({ status: 'PLOT_SELECTED', plotId: 30 });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ status: 'PLOT_SELECTED', handedToBilling: true, bookingStatus: 'PLOT_RESERVED' });
    expect(prisma.plotSite.updateMany).toHaveBeenCalledWith({ where: { id: 30, tenantId: 7, isActive: true, availability: 'AVAILABLE' }, data: { availability: 'RESERVED' } });
    expect(prisma.plotBooking.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ contactId: 61, plotSiteId: 30, transportPersonId: 41, plotBrokerId: 51 }),
    }));
  });

  test('reserves another plot assigned to the same customer', async () => {
    prisma.plotBroker.findFirst.mockResolvedValue({
      id: 51, userId: 3, tenantId: 7,
      assignmentPairsJson: '[{"customerId":61,"plotSiteId":30}]',
      workflowStatusJson: '{"customer-61-plot-30":{"status":"PLOT_SHOWN"}}', isActive: true,
    });
    prisma.transportPerson.findMany.mockResolvedValue([{
      id: 41,
      assignmentPairsJson: '[{"customerId":61,"plotSiteId":30}]',
      assignmentStatusJson: '{"customer-61-plot-30":{"status":"COMPLETED"}}',
    }]);
    prisma.plotBooking.findMany.mockResolvedValue([
      { id: 91, contactId: 61, plotSiteId: 30, customerPickupId: 81 },
      { id: 92, contactId: 61, plotSiteId: 31, customerPickupId: 81 },
    ]);
    prisma.plotSite.findFirst.mockResolvedValue({ id: 31, name: 'btm', price: 500000, availability: 'AVAILABLE', isActive: true });
    prisma.plotBooking.update.mockResolvedValue({ id: 92, bookingNumber: 'BOOK-PLOT-10', status: 'PLOT_RESERVED' });

    const response = await request(makeApp({ role: 'USER' }))
      .patch('/api/pickup-plot-inventory/brokers/me/assignments/customer-61-plot-30/workflow')
      .send({ status: 'PLOT_SELECTED', plotId: 31 });

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(prisma.plotBooking.update).toHaveBeenCalledWith({
      where: { id: 92 },
      data: expect.objectContaining({
        transportPersonId: 41,
        plotBrokerId: 51,
        status: 'PLOT_RESERVED',
        totalAmount: 500000,
        balance: 500000,
      }),
    });
    expect(prisma.plotBooking.create).not.toHaveBeenCalled();
    expect(response.body).toMatchObject({ status: 'PLOT_SELECTED', handedToBilling: true });
  });

  test('rejects a plot that is not assigned to the customer', async () => {
    prisma.plotBroker.findFirst.mockResolvedValue({
      id: 51, userId: 3, tenantId: 7, customerIdsJson: '[61]', plotSiteIdsJson: '[30]',
      workflowStatusJson: '{"customer-61":{"status":"PLOT_SHOWN"}}', isActive: true,
    });
    prisma.transportPerson.findMany.mockResolvedValue([{
      id: 41, customerIdsJson: '[61]', plotSiteIdsJson: '[30]', assignmentStatusJson: '{"customer-61":{"status":"COMPLETED"}}',
    }]);
    const response = await request(makeApp({ role: 'USER' }))
      .patch('/api/pickup-plot-inventory/brokers/me/customers/61/workflow')
      .send({ status: 'PLOT_SELECTED', plotId: 31 });

    expect(response.status).toBe(409);
    expect(response.body.code).toBe('PLOT_NOT_ASSIGNED_TO_CUSTOMER');
    expect(prisma.plotSite.findFirst).not.toHaveBeenCalled();
    expect(prisma.plotBooking.create).not.toHaveBeenCalled();
  });

  test('only one concurrent reservation wins even when both reads see AVAILABLE', async () => {
    prisma.plotBroker.findFirst.mockResolvedValue({
      id: 51, userId: 3, tenantId: 7, customerIdsJson: '[61]', plotSiteIdsJson: '[30]',
      workflowStatusJson: '{"customer-61":{"status":"PLOT_SHOWN"}}', isActive: true,
    });
    prisma.transportPerson.findMany.mockResolvedValue([{
      id: 41, customerIdsJson: '[61]', plotSiteIdsJson: '[30]', assignmentStatusJson: '{"customer-61":{"status":"COMPLETED"}}',
    }]);
    prisma.plotSite.findFirst.mockResolvedValue({ id: 30, availability: 'AVAILABLE', isActive: true });
    prisma.plotSite.updateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 });
    const responses = await Promise.all([0, 1].map(() => request(makeApp({ role: 'USER' }))
      .patch('/api/pickup-plot-inventory/brokers/me/customers/61/workflow').send({ status: 'PLOT_SELECTED' })));
    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
    expect(responses.find((response) => response.status === 409).body.code).toBe('PLOT_NOT_AVAILABLE');
    expect(prisma.plotBooking.create).toHaveBeenCalledTimes(1);
  });

  test('records a no-show so the visit can be rescheduled', async () => {
    prisma.plotBroker.findFirst.mockResolvedValue({
      id: 51, userId: 3, tenantId: 7, customerIdsJson: '[61]',
      plotSiteIdsJson: '[30]',
      workflowStatusJson: '{"customer-61":{"status":"REMINDER_SENT"}}', isActive: true,
    });
    prisma.transportPerson.findMany.mockResolvedValue([{
      customerIdsJson: '[61]', plotSiteIdsJson: '[30]', assignmentStatusJson: '{"customer-61":{"status":"COMPLETED"}}',
    }]);
    prisma.plotBroker.update.mockResolvedValue({ id: 51 });

    const response = await request(makeApp({ role: 'USER' }))
      .patch('/api/pickup-plot-inventory/brokers/me/customers/61/workflow')
      .send({ status: 'NO_SHOW' });

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body).toMatchObject({ status: 'NO_SHOW', handedToBilling: false });
    expect(JSON.parse(prisma.plotBroker.updateMany.mock.calls[0][0].data.workflowStatusJson)['customer-61-plot-30'].status).toBe('NO_SHOW');
  });

  test('lists interested customers in the billing workspace', async () => {
    prisma.user.findFirst.mockResolvedValue({
      id: 3, name: 'Bina', email: 'billing@example.com',
      userRoles: [{ role: { key: 'BILLING', name: 'Billing Department' } }],
    });
    prisma.billingPerson.findFirst.mockResolvedValue({ id: 71, userId: 3, name: 'Bina', customerIdsJson: '[61]', plotSiteIdsJson: '[30]', isActive: true });
    prisma.plotBroker.findMany.mockResolvedValue([{
      id: 51, tenantId: 7, name: 'Sanjeev', customerIdsJson: '[61,62]', plotSiteIdsJson: '[30,31]',
      workflowStatusJson: '{"customer-61":{"status":"INTEREST_CONFIRMED","billingStatus":"INVOICE_CREATED"},"customer-62":{"status":"NOT_INTERESTED"}}',
      isActive: true,
    }]);
    prisma.contact.findMany.mockResolvedValue([{ id: 61, name: 'Li Wei', email: 'li@example.com' }]);
    prisma.plotSite.findMany.mockResolvedValue([{ id: 30, name: 'Plot 24', plotNumber: 'A-24', price: 250000 }]);

    const response = await request(makeApp({ role: 'USER' })).get('/api/pickup-plot-inventory/billing/me');

    expect(response.status).toBe(200);
    expect(response.body.assignments).toEqual([expect.objectContaining({
      assignmentKey: '51-61-30', status: 'INVOICE_CREATED',
      customer: expect.objectContaining({ name: 'Li Wei' }), broker: { id: 51, name: 'Sanjeev' },
      plot: expect.objectContaining({ id: 30, plotNumber: 'A-24' }),
    })]);
    expect(response.body.waitingAssignments).toEqual([]);
    expect(response.body.summary).toEqual({ total: 1, waiting: 0, active: 1, completed: 0 });
  });

  test('hides deleted customers from the Billing workspace and its counts', async () => {
    prisma.billingPerson.findFirst.mockResolvedValue({
      id: 71, userId: 3, name: 'Bina',
      assignmentPairsJson: '[{"customerId":61,"plotSiteId":30}]', isActive: true,
    });
    prisma.contact.findMany.mockResolvedValue([]);

    const response = await request(makeApp({ role: 'USER' })).get('/api/pickup-plot-inventory/billing/me');

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(prisma.contact.findMany).toHaveBeenCalledWith({
      where: { tenantId: 7, id: { in: [61] }, deletedAt: null },
      select: { id: true, name: true, phone: true, email: true, company: true },
    });
    expect(response.body.assignments).toEqual([]);
    expect(response.body.waitingAssignments).toEqual([]);
    expect(response.body.summary).toEqual({ total: 0, waiting: 0, active: 0, completed: 0 });
  });

  test('shows directly assigned billing customers while they await the sales handoff', async () => {
    prisma.user.findFirst.mockResolvedValue({
      id: 3, name: 'Bina', email: 'billing@example.com',
      userRoles: [{ role: { key: 'BILLING', name: 'Billing Department' } }],
    });
    prisma.billingPerson.findFirst.mockResolvedValue({
      id: 71, userId: 3, name: 'Bina',
      assignmentPairsJson: '[{"customerId":61,"plotSiteId":30},{"customerId":62,"plotSiteId":31}]',
      isActive: true,
    });
    prisma.plotBroker.findMany.mockResolvedValue([{
      id: 51, tenantId: 7, name: 'Sanjeev', assignmentPairsJson: '[{"customerId":61,"plotSiteId":30}]',
      workflowStatusJson: '{"customer-61-plot-30":{"status":"VISIT_SCHEDULED"}}', isActive: true,
    }]);
    prisma.contact.findMany.mockResolvedValue([
      { id: 61, name: 'Muskan', email: 'muskan@example.com' },
      { id: 62, name: 'Sarukh', email: 'sarukh@example.com' },
    ]);
    prisma.plotSite.findMany.mockResolvedValue([
      { id: 30, name: 'Koramangala Plot' },
      { id: 31, name: 'Prime West Plot' },
    ]);

    const response = await request(makeApp({ role: 'USER' })).get('/api/pickup-plot-inventory/billing/me');

    expect(response.status).toBe(200);
    expect(response.body.assignments).toEqual([]);
    expect(response.body.waitingAssignments).toEqual([
      expect.objectContaining({
        assignmentKey: 'waiting-61-30', status: 'AWAITING_SALES_EXECUTIVE_HANDOFF', salesStatus: 'VISIT_SCHEDULED',
        customer: expect.objectContaining({ name: 'Muskan' }), plot: expect.objectContaining({ name: 'Koramangala Plot' }),
      }),
      expect.objectContaining({
        assignmentKey: 'waiting-62-31', status: 'AWAITING_SALES_EXECUTIVE_HANDOFF', salesStatus: null,
        customer: expect.objectContaining({ name: 'Sarukh' }), plot: expect.objectContaining({ name: 'Prime West Plot' }),
      }),
    ]);
    expect(response.body.summary).toEqual({ total: 2, waiting: 2, active: 0, completed: 0 });
  });

  test('does not expose interested customers when the billing person has no assignments', async () => {
    prisma.user.findFirst.mockResolvedValue({
      id: 3, name: 'Bina', userRoles: [{ role: { key: 'BILLING' } }],
    });
    prisma.billingPerson.findFirst.mockResolvedValue({
      id: 71, userId: 3, name: 'Bina', customerIdsJson: null, plotSiteIdsJson: null, assignmentPairsJson: null, isActive: true,
    });
    prisma.plotBroker.findMany.mockResolvedValue([{
      id: 51, name: 'Sanjeev', customerIdsJson: '[61]', plotSiteIdsJson: '[30]',
      workflowStatusJson: '{"customer-61":{"status":"INTEREST_CONFIRMED","billingStatus":"PLOT_RESERVED"}}',
      isActive: true,
    }]);

    const response = await request(makeApp({ role: 'USER' })).get('/api/pickup-plot-inventory/billing/me');

    expect(response.status).toBe(200);
    expect(response.body.assignments).toEqual([]);
    expect(response.body.waitingAssignments).toEqual([]);
    expect(response.body.summary).toEqual({ total: 0, waiting: 0, active: 0, completed: 0 });
  });

  test('prevents a billing person from mutating another person assignment', async () => {
    prisma.user.findFirst.mockResolvedValue({ id: 3, userRoles: [{ role: { key: 'BILLING' } }] });
    prisma.billingPerson.findFirst.mockResolvedValue({
      id: 71, userId: 3, customerIdsJson: '[62]', plotSiteIdsJson: '[31]', isActive: true,
    });

    const response = await request(makeApp({ role: 'USER' }))
      .patch('/api/pickup-plot-inventory/billing/me/assignments/51-61-30/status')
      .send({ status: 'INVOICE_CREATED' });

    expect(response.status).toBe(404);
    expect(response.body.code).toBe('BILLING_ASSIGNMENT_NOT_FOUND');
    expect(prisma.plotBroker.update).not.toHaveBeenCalled();
  });

  test('advances billing assignments sequentially', async () => {
    prisma.user.findFirst.mockResolvedValue({
      id: 3, userRoles: [{ role: { key: 'BILLING' } }],
    });
    prisma.billingPerson.findFirst.mockResolvedValue({ id: 71, userId: 3, name: 'Bina', customerIdsJson: '[61]', plotSiteIdsJson: '[30]', isActive: true });
    prisma.plotBroker.findFirst.mockResolvedValue({
      id: 51, tenantId: 7, customerIdsJson: '[61]',
      plotSiteIdsJson: '[30]',
      workflowStatusJson: '{"customer-61":{"status":"INTEREST_CONFIRMED","billingStatus":"BILLING","plotId":30}}',
      isActive: true,
    });
    prisma.plotBroker.update.mockResolvedValue({ id: 51 });
    prisma.contact.findFirst.mockResolvedValue({ id: 61, name: 'Li Wei', email: 'li@example.com', phone: '9000022222' });
    prisma.plotSite.findFirst.mockResolvedValue({ id: 30, name: 'Plot 24', price: 250000, availability: 'RESERVED', isActive: true });
    prisma.invoice.create.mockResolvedValue({ id: 81, invoiceNum: 'PLOT-ABC123', status: 'UNPAID' });

    const response = await request(makeApp({ role: 'USER' }))
      .patch('/api/pickup-plot-inventory/billing/me/assignments/51-61-30/status')
      .send({ status: 'INVOICE_CREATED' });

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body).toMatchObject({ assignmentKey: '51-61-30', status: 'INVOICE_CREATED' });
    const saved = JSON.parse(prisma.plotBroker.updateMany.mock.calls[0][0].data.workflowStatusJson)['customer-61-plot-30'];
    expect(saved).toMatchObject({ status: 'INTEREST_CONFIRMED', billingStatus: 'INVOICE_CREATED', invoiceId: 81, invoiceNum: 'PLOT-ABC123' });
    expect(prisma.invoice.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ amount: 250000, contactId: 61, tenantId: 7 }),
    }));
    expect(prisma.plotInvoiceItem.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ invoiceId: 81, itemId: 30, amount: 250000 }),
    }));
    expect(prisma.plotWorkflowEvent.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ contactId: 61, stage: 'BILLING', toStatus: 'INVOICE_CREATED' }),
    }));
  });

  test('claims a customer when the first billing person starts and removes it from peers', async () => {
    prisma.user.findFirst.mockResolvedValue({ id: 3, userRoles: [{ role: { key: 'BILLING' } }] });
    prisma.billingPerson.findFirst.mockResolvedValue({
      id: 71, userId: 3, tenantId: 7, customerIdsJson: '[61]', plotSiteIdsJson: '[30]',
      assignmentPairsJson: '[{"customerId":61,"plotSiteId":30}]', isActive: true,
    });
    prisma.billingPerson.findMany.mockResolvedValue([{
      id: 72, tenantId: 7, customerIdsJson: '[61,62]', plotSiteIdsJson: '[30,31]',
      assignmentPairsJson: '[{"customerId":61,"plotSiteId":30},{"customerId":62,"plotSiteId":31}]', isActive: true,
    }]);
    prisma.plotBroker.findFirst.mockResolvedValue({
      id: 51, tenantId: 7, customerIdsJson: '[61]', plotSiteIdsJson: '[30]',
      assignmentPairsJson: '[{"customerId":61,"plotSiteId":30}]',
      workflowStatusJson: '{"customer-61-plot-30":{"status":"INTEREST_CONFIRMED","billingStatus":"PLOT_RESERVED","plotId":30,"bookingId":91}}',
      isActive: true,
    });
    prisma.plotBooking.findFirst.mockResolvedValue({ id: 91, bookingNumber: 'BOOK-ABC123', billingPersonId: null });

    const response = await request(makeApp({ role: 'USER' }))
      .patch('/api/pickup-plot-inventory/billing/me/assignments/51-61-30/status')
      .send({ status: 'BILLING' });

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(prisma.billingPerson.update).toHaveBeenCalledWith({
      where: { id: 72 },
      data: {
        customerIdsJson: '[62]',
        assignmentPairsJson: '[{"customerId":62,"plotSiteId":31}]',
      },
    });
    expect(prisma.plotBooking.update).toHaveBeenCalledWith({
      where: { id: 91 },
      data: { status: 'BILLING', billingPersonId: 71 },
    });
  });

  test('rejects a partial receipt and keeps the plot reserved until the full balance is verified', async () => {
    prisma.user.findFirst.mockResolvedValue({ id: 3, userRoles: [{ role: { key: 'BILLING' } }] });
    prisma.billingPerson.findFirst.mockResolvedValue({ id: 71, userId: 3, customerIdsJson: '[61]', plotSiteIdsJson: '[30]', isActive: true });
    prisma.plotBroker.findFirst.mockResolvedValue({
      id: 51, customerIdsJson: '[61]', plotSiteIdsJson: '[30]', isActive: true,
      workflowStatusJson: '{"customer-61-plot-30":{"status":"INTEREST_CONFIRMED","billingStatus":"PAYMENT_PENDING","plotId":30,"invoiceId":81,"bookingId":91}}',
    });
    prisma.plotBooking.findFirst.mockResolvedValue({ id: 91, bookingNumber: 'BOOK-ABC123' });
    prisma.invoice.findFirst.mockResolvedValue({ id: 81, invoiceNum: 'PLOT-ABC123', amount: 250000, amountPaid: 0, balance: 250000 });
    prisma.payment.create.mockResolvedValue({ id: 101, status: 'SUCCESS', amount: 50000, gatewayId: 'UTR-PARTIAL' });
    prisma.invoice.update.mockResolvedValue({ id: 81, status: 'PARTIALLY_PAID', amount: 250000, amountPaid: 50000, balance: 200000 });

    const response = await request(makeApp({ role: 'USER' }))
      .patch('/api/pickup-plot-inventory/billing/me/assignments/51-61-30/status')
      .send({ status: 'PAYMENT_RECEIVED', paymentMethod: 'upi', transactionRef: 'UTR-PARTIAL', amount: 50000 });

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ code: 'INVALID_PAYMENT_AMOUNT', balance: 250000 });
    expect(prisma.plotSite.update).not.toHaveBeenCalled();
    expect(prisma.payment.create).not.toHaveBeenCalled();
  });

  test('records a full-balance payment without selling the plot before verification', async () => {
    prisma.user.findFirst.mockResolvedValue({ id: 3, userRoles: [{ role: { key: 'BILLING' } }] });
    prisma.billingPerson.findFirst.mockResolvedValue({ id: 71, userId: 3, customerIdsJson: '[61]', plotSiteIdsJson: '[30]', isActive: true });
    prisma.plotBroker.findFirst.mockResolvedValue({
      id: 51, customerIdsJson: '[61]', plotSiteIdsJson: '[30]', isActive: true,
      workflowStatusJson: '{"customer-61-plot-30":{"status":"INTEREST_CONFIRMED","billingStatus":"PAYMENT_PENDING","plotId":30,"invoiceId":81,"bookingId":91,"amountPaid":50000,"balance":200000}}',
    });
    prisma.plotBooking.findFirst.mockResolvedValue({ id: 91, bookingNumber: 'BOOK-ABC123' });
    prisma.invoice.findFirst.mockResolvedValue({ id: 81, invoiceNum: 'PLOT-ABC123', amount: 250000, amountPaid: 50000, balance: 200000 });
    prisma.payment.create.mockResolvedValue({ id: 102, status: 'PENDING', amount: 200000, gatewayId: 'UTR-FINAL' });

    const response = await request(makeApp({ role: 'USER' }))
      .patch('/api/pickup-plot-inventory/billing/me/assignments/51-61-30/status')
      .send({ status: 'PAYMENT_RECEIVED', paymentMethod: 'bank_transfer', transactionRef: 'UTR-FINAL', amount: 200000 });

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body).toMatchObject({ status: 'PAYMENT_RECEIVED', payment: { status: 'PENDING', amount: 200000, transactionRef: 'UTR-FINAL' } });
    expect(prisma.plotSite.update).not.toHaveBeenCalled();
    expect(prisma.plotWorkflowEvent.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ stage: 'PAYMENT', toStatus: 'PAYMENT_RECEIVED' }),
    }));
  });

  test('returns 409 when the database rejects a concurrently reused payment reference', async () => {
    prisma.user.findFirst.mockResolvedValue({ id: 3, userRoles: [{ role: { key: 'BILLING' } }] });
    prisma.billingPerson.findFirst.mockResolvedValue({ id: 71, userId: 3, customerIdsJson: '[61]', plotSiteIdsJson: '[30]', isActive: true });
    prisma.plotBroker.findFirst.mockResolvedValue({
      id: 51, customerIdsJson: '[61]', plotSiteIdsJson: '[30]', isActive: true,
      workflowStatusJson: '{"customer-61-plot-30":{"status":"INTEREST_CONFIRMED","billingStatus":"PAYMENT_PENDING","plotId":30,"invoiceId":81,"bookingId":91}}',
    });
    prisma.plotBooking.findFirst.mockResolvedValue({ id: 91 });
    prisma.invoice.findFirst.mockResolvedValue({ id: 81, amount: 250000, balance: 250000 });
    prisma.payment.create.mockRejectedValueOnce({ code: 'P2002', meta: { target: 'Payment_tenantId_plotPaymentReference_key' } });
    const response = await request(makeApp({ role: 'USER' }))
      .patch('/api/pickup-plot-inventory/billing/me/assignments/51-61-30/status')
      .send({ status: 'PAYMENT_RECEIVED', paymentMethod: 'bank_transfer', transactionRef: 'RACE-REF' });
    expect(response.status).toBe(409);
    expect(response.body.code).toBe('DUPLICATE_TRANSACTION_REFERENCE');
    expect(prisma.payment.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ tenantId: 7, plotPaymentReference: 'RACE-REF' }),
    }));
    expect(prisma.plotBooking.update).not.toHaveBeenCalled();
    expect(prisma.plotWorkflowEvent.create).not.toHaveBeenCalled();
  });

  test('verifies the recorded payment without selling the plot', async () => {
    prisma.user.findFirst.mockResolvedValue({ id: 3, userRoles: [{ role: { key: 'BILLING' } }] });
    prisma.billingPerson.findFirst.mockResolvedValue({ id: 71, userId: 3, customerIdsJson: '[61]', plotSiteIdsJson: '[30]', isActive: true });
    prisma.plotBroker.findFirst.mockResolvedValue({
      id: 51, customerIdsJson: '[61]', plotSiteIdsJson: '[30]', isActive: true,
      workflowStatusJson: '{"customer-61-plot-30":{"status":"INTEREST_CONFIRMED","billingStatus":"PAYMENT_RECEIVED","plotId":30,"invoiceId":81,"invoiceAmount":250000,"paymentId":102,"paymentMethod":"upi","paymentReceivedAmount":250000,"bookingId":91}}',
    });
    prisma.plotBooking.findFirst.mockResolvedValue({ id: 91, bookingNumber: 'BOOK-ABC123' });
    prisma.payment.update.mockResolvedValue({ id: 102, status: 'SUCCESS', amount: 250000, gatewayId: 'UTR-FINAL' });
    prisma.invoice.update.mockResolvedValue({ id: 81, invoiceNum: 'PLOT-ABC123', status: 'PAID', amount: 250000, amountPaid: 250000, balance: 0 });

    const response = await request(makeApp({ role: 'USER' }))
      .patch('/api/pickup-plot-inventory/billing/me/assignments/51-61-30/status')
      .send({ status: 'PAYMENT_VERIFIED' });

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body).toMatchObject({ status: 'PAYMENT_VERIFIED', amountPaid: 250000, balance: 0 });
    expect(prisma.payment.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 102 }, data: expect.objectContaining({ status: 'SUCCESS' }) }));
    expect(prisma.invoice.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 81 }, data: expect.objectContaining({ status: 'PAID', balance: 0 }) }));
    expect(prisma.plotSite.update).not.toHaveBeenCalled();
    expect(prisma.plotWorkflowEvent.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ stage: 'PAYMENT', toStatus: 'PAYMENT_VERIFIED' }),
    }));
    expect(eventBus.emitEvent).toHaveBeenCalledWith('payment.collected', expect.objectContaining({
      paymentId: 102,
      contactId: 61,
      bookingId: 91,
    }), 7, undefined);
  });

  test.each([
    ['PLOT_RESERVED', 'BILLING'],
    ['PAYMENT_VERIFIED', 'BOOKING_CONFIRMED'],
    ['PLOT_SOLD', 'TRANSACTION_COMPLETED'],
  ])('advances booking from %s to %s without changing plot availability', async (currentStatus, nextStatus) => {
    prisma.user.findFirst.mockResolvedValue({ id: 3, userRoles: [{ role: { key: 'BILLING' } }] });
    prisma.billingPerson.findFirst.mockResolvedValue({ id: 71, userId: 3, customerIdsJson: '[61]', plotSiteIdsJson: '[30]', isActive: true });
    prisma.plotBroker.findFirst.mockResolvedValue({
      id: 51, customerIdsJson: '[61]', plotSiteIdsJson: '[30]', isActive: true,
      workflowStatusJson: JSON.stringify({
        'customer-61-plot-30': {
          status: 'INTEREST_CONFIRMED', billingStatus: currentStatus, plotId: 30,
          invoiceId: 81, paymentId: 102, bookingId: 91,
        },
      }),
    });
    prisma.plotBooking.findFirst.mockResolvedValue({ id: 91, bookingNumber: 'BOOK-ABC123' });

    const response = await request(makeApp({ role: 'USER' }))
      .patch('/api/pickup-plot-inventory/billing/me/assignments/51-61-30/status')
      .send({ status: nextStatus });

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.status).toBe(nextStatus);
    expect(prisma.plotSite.update).not.toHaveBeenCalled();
  });

  test('confirms a fully paid booking when workflow JSON is still payment pending', async () => {
    prisma.user.findFirst.mockResolvedValue({ id: 3, userRoles: [{ role: { key: 'BILLING' } }] });
    prisma.billingPerson.findFirst.mockResolvedValue({
      id: 71, userId: 3, customerIdsJson: '[61]', plotSiteIdsJson: '[30]', isActive: true,
    });
    prisma.plotBroker.findFirst.mockResolvedValue({
      id: 51, customerIdsJson: '[61]', plotSiteIdsJson: '[30]', isActive: true,
      workflowStatusJson: JSON.stringify({
        'customer-61-plot-30': {
          status: 'PLOT_SELECTED', billingStatus: 'PAYMENT_PENDING', plotId: 30, bookingId: 91,
        },
      }),
    });
    prisma.plotBooking.findFirst.mockResolvedValue({
      id: 91, bookingNumber: 'BOOK-ABC123', totalAmount: 200000,
      amountPaid: 200000, balance: 0, paymentStatus: 'PAID',
    });

    const response = await request(makeApp({ role: 'USER' }))
      .patch('/api/pickup-plot-inventory/billing/me/assignments/51-61-30/status')
      .send({ status: 'BOOKING_CONFIRMED' });

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.status).toBe('BOOKING_CONFIRMED');
    expect(prisma.plotBooking.update).toHaveBeenCalledWith({
      where: { id: 91 },
      data: { status: 'BOOKING_CONFIRMED' },
    });
    const saved = JSON.parse(prisma.plotBroker.updateMany.mock.calls[0][0].data.workflowStatusJson);
    expect(saved['customer-61-plot-30'].billingStatus).toBe('BOOKING_CONFIRMED');
    expect(eventBus.emitEvent).toHaveBeenCalledWith('plot.confirmed', {
      contactId: 61,
      plotSiteId: 30,
      bookingId: 91,
    }, 7, undefined);
  });

  test('rejects a stale billing transition after the booking was cancelled', async () => {
    prisma.user.findFirst.mockResolvedValue({ id: 3, userRoles: [{ role: { key: 'BILLING' } }] });
    prisma.billingPerson.findFirst.mockResolvedValue({ id: 71, userId: 3, customerIdsJson: '[61]', plotSiteIdsJson: '[30]', isActive: true });
    prisma.plotBroker.findFirst.mockResolvedValue({
      id: 51, customerIdsJson: '[61]', plotSiteIdsJson: '[30]', isActive: true,
      workflowStatusJson: JSON.stringify({ 'customer-61-plot-30': { status: 'PLOT_SELECTED', billingStatus: 'PAYMENT_PENDING', plotId: 30, bookingId: 91 } }),
    });
    prisma.plotBooking.findFirst.mockResolvedValueOnce({ id: 91, paymentStatus: 'PAID', amountPaid: 100, balance: 0 }).mockResolvedValueOnce(null);
    const response = await request(makeApp({ role: 'USER' }))
      .patch('/api/pickup-plot-inventory/billing/me/assignments/51-61-30/status')
      .send({ status: 'BOOKING_CONFIRMED' });
    expect(response.status).toBe(409);
    expect(response.body.code).toBe('PLOT_ASSIGNMENT_REMOVED');
    expect(prisma.plotBooking.update).not.toHaveBeenCalled();
  });

  test('marks the plot sold only after booking confirmation', async () => {
    prisma.user.findFirst.mockResolvedValue({ id: 3, userRoles: [{ role: { key: 'BILLING' } }] });
    prisma.billingPerson.findFirst.mockResolvedValue({ id: 71, userId: 3, customerIdsJson: '[61]', plotSiteIdsJson: '[30]', isActive: true });
    prisma.plotBroker.findFirst.mockResolvedValue({
      id: 51, customerIdsJson: '[61]', plotSiteIdsJson: '[30]', isActive: true,
      workflowStatusJson: '{"customer-61-plot-30":{"status":"INTEREST_CONFIRMED","billingStatus":"BOOKING_CONFIRMED","plotId":30,"invoiceId":81,"paymentId":102,"bookingId":91}}',
    });
    prisma.plotBooking.findFirst.mockResolvedValue({ id: 91, bookingNumber: 'BOOK-ABC123' });
    prisma.plotSite.update.mockResolvedValue({ id: 30, availability: 'SOLD' });

    const response = await request(makeApp({ role: 'USER' }))
      .patch('/api/pickup-plot-inventory/billing/me/assignments/51-61-30/status')
      .send({ status: 'PLOT_SOLD' });

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body).toMatchObject({ status: 'PLOT_SOLD', plotAvailability: 'SOLD' });
    expect(prisma.plotSite.update).toHaveBeenCalledWith({ where: { id: 30 }, data: { availability: 'SOLD' } });
  });

  test('lists billing persons and unlinked staff with Billing Workspace access', async () => {
    prisma.role.findMany.mockResolvedValue([{ id: 10, key: 'OPERATIONS', name: 'Operations', permissions: [{ module: 'billing_workspace', action: 'read' }] }]);
    prisma.billingPerson.findMany.mockResolvedValue([{
      id: 71, userId: 21, name: 'Bina Shah', phone: '9000011111', email: 'bina@example.com', isActive: true,
      customerIdsJson: '[61]', plotSiteIdsJson: '[30]',
      user: { id: 21, name: 'Bina Shah', email: 'bina@example.com', phone: '9000011111' },
    }]);
    prisma.customerPickup.findMany.mockResolvedValue([{
      contact: { id: 61, name: 'Li Wei' },
    }]);
    prisma.plotSite.findMany.mockResolvedValue([{ id: 30, name: 'Plot 24', isActive: true }]);
    prisma.user.findMany.mockResolvedValue([
      { id: 21, name: 'Bina Shah', email: 'bina@example.com' },
      { id: 22, name: 'Ravi Billing', email: 'ravi@example.com' },
    ]);

    const response = await request(makeApp()).get('/api/pickup-plot-inventory/billing-persons');

    expect(response.status).toBe(200);
    expect(response.body.billingPersons).toEqual([expect.objectContaining({
      customerIds: [61], plotSiteIds: [30],
      customers: [expect.objectContaining({ id: 61 })], plots: [expect.objectContaining({ id: 30 })],
    })]);
    expect(response.body.customers).toEqual([expect.objectContaining({ id: 61 })]);
    expect(response.body.plots).toEqual([expect.objectContaining({ id: 30 })]);
    expect(response.body.staffUsers).toEqual([expect.objectContaining({ id: 22 })]);
    expect(response.body.summary).toEqual({ total: 1, active: 1, linked: 1 });
    expect(prisma.billingPerson.findMany.mock.calls[0][0].where).toEqual({
      tenantId: 7,
      OR: [{ userId: null }, { user: { is: { deactivatedAt: null } } }],
    });
  });

  test('shows a started transport customer only on the transport person who claimed it', async () => {
    prisma.transportPerson.findMany.mockResolvedValue([
      {
        id: 41, name: 'Sant', isActive: true, customerIdsJson: '[61]', plotSiteIdsJson: '[30]',
        assignmentPairsJson: '[{"customerId":61,"plotSiteId":30}]',
        assignmentStatusJson: '{"customer-61-plot-30":{"status":"ACCEPTED"}}',
      },
      {
        id: 42, name: 'Raj', isActive: true, customerIdsJson: '[61]', plotSiteIdsJson: '[30]',
        assignmentPairsJson: '[{"customerId":61,"plotSiteId":30}]', assignmentStatusJson: null,
      },
    ]);
    prisma.customerPickup.findMany.mockResolvedValue([{ contact: { id: 61, name: 'Muskan' } }]);
    prisma.plotSite.findMany.mockResolvedValue([{ id: 30, name: 'Plot 30', isActive: true }]);

    const response = await request(makeApp()).get('/api/pickup-plot-inventory/transport-persons');

    expect(response.status).toBe(200);
    expect(response.body.customers).toEqual([expect.objectContaining({ id: 61, claimedByPersonId: 41 })]);
    expect(response.body.transportPersons.find((row) => row.id === 41).customerIds).toEqual([61]);
    expect(response.body.transportPersons.find((row) => row.id === 42).customerIds).toEqual([]);
  });

  test('shows a started broker customer only on the broker who claimed it', async () => {
    prisma.plotBroker.findMany.mockResolvedValue([
      {
        id: 51, name: 'Harsh', isActive: true, customerIdsJson: '[61]', plotSiteIdsJson: '[30]',
        assignmentPairsJson: '[{"customerId":61,"plotSiteId":30}]',
        workflowStatusJson: '{"customer-61-plot-30":{"status":"EXPLANATION_STARTED"}}',
      },
      {
        id: 52, name: 'Asha', isActive: true, customerIdsJson: '[61]', plotSiteIdsJson: '[30]',
        assignmentPairsJson: '[{"customerId":61,"plotSiteId":30}]', workflowStatusJson: null,
      },
    ]);
    prisma.transportPerson.findMany.mockResolvedValue([{ assignmentPairsJson: '[{"customerId":61,"plotSiteId":30}]' }]);
    prisma.customerPickup.findMany.mockResolvedValue([{ contact: { id: 61, name: 'Muskan' } }]);
    prisma.plotSite.findMany.mockResolvedValue([{ id: 30, name: 'Plot 30', isActive: true }]);

    const response = await request(makeApp()).get('/api/pickup-plot-inventory/brokers');

    expect(response.status).toBe(200);
    expect(response.body.customers).toEqual([expect.objectContaining({ id: 61, claimedByPersonId: 51 })]);
    expect(response.body.brokers.find((row) => row.id === 51).customerIds).toEqual([61]);
    expect(response.body.brokers.find((row) => row.id === 52).customerIds).toEqual([]);
    expect(prisma.plotBroker.findMany.mock.calls[0][0].where).toEqual({
      tenantId: 7,
      OR: [{ userId: null }, { user: { is: { deactivatedAt: null } } }],
    });
  });

  test('shows a started billing customer only on the billing person who claimed it', async () => {
    prisma.billingPerson.findMany.mockResolvedValue([
      { id: 71, name: 'Bina', isActive: true, customerIdsJson: '[61]', plotSiteIdsJson: '[30]' },
      { id: 72, name: 'Ravi', isActive: true, customerIdsJson: '[61]', plotSiteIdsJson: '[30]' },
    ]);
    prisma.transportPerson.findMany.mockResolvedValue([{ assignmentPairsJson: '[{"customerId":61,"plotSiteId":30}]' }]);
    prisma.customerPickup.findMany.mockResolvedValue([{ contact: { id: 61, name: 'Muskan' } }]);
    prisma.plotSite.findMany.mockResolvedValue([{ id: 30, name: 'Plot 30', isActive: true }]);
    prisma.plotBooking.findMany.mockImplementation(({ where }) => Promise.resolve(
      where.status === 'TRANSACTION_COMPLETED' ? [] : [{ contactId: 61, billingPersonId: 71 }],
    ));

    const response = await request(makeApp()).get('/api/pickup-plot-inventory/billing-persons');

    expect(response.status).toBe(200);
    expect(response.body.customers).toEqual([expect.objectContaining({ id: 61, claimedByPersonId: 71 })]);
    expect(response.body.billingPersons.find((row) => row.id === 71).customerIds).toEqual([61]);
    expect(response.body.billingPersons.find((row) => row.id === 72).customerIds).toEqual([]);
  });

  test('ignores billing claims left behind by deleted staff profiles', async () => {
    prisma.billingPerson.findMany.mockResolvedValue([
      { id: 72, userId: 22, name: 'Ravi', isActive: true, customerIdsJson: null, plotSiteIdsJson: null },
    ]);
    prisma.customerPickup.findMany.mockResolvedValue([{ contact: { id: 61, name: 'Muskan' } }]);
    prisma.plotBooking.findMany.mockImplementation(({ where }) => Promise.resolve(
      where.status === 'TRANSACTION_COMPLETED' ? [] : [{ contactId: 61, billingPersonId: 71 }],
    ));

    const response = await request(makeApp()).get('/api/pickup-plot-inventory/billing-persons');

    expect(response.status).toBe(200);
    expect(response.body.customers).toEqual([
      expect.objectContaining({ id: 61, claimedByPersonId: null }),
    ]);
  });

  test('links existing staff with Billing Workspace access to a billing person profile', async () => {
    prisma.user.findFirst.mockResolvedValue({
      id: 22, name: 'Ravi Billing', email: 'ravi@example.com', phone: '9000022222',
      userRoles: [{ role: { key: 'OPERATIONS', name: 'Operations', permissions: [{ module: 'billing_workspace', action: 'read' }] } }],
    });
    prisma.billingPerson.findFirst.mockResolvedValue(null);
    prisma.contact.findMany.mockResolvedValue([{ id: 61 }]);
    prisma.plotSite.findMany.mockResolvedValue([{ id: 30 }]);
    prisma.transportPerson.findMany.mockResolvedValue([{
      assignmentPairsJson: '[{"customerId":61,"plotSiteId":30}]',
    }]);
    prisma.billingPerson.create.mockResolvedValue({
      id: 72, userId: 22, name: 'Ravi Billing', phone: '9000022222', email: 'ravi@example.com',
      customerIdsJson: '[61]', plotSiteIdsJson: '[30]', isActive: true,
    });

    const response = await request(makeApp()).post('/api/pickup-plot-inventory/billing-persons').send({
      name: 'Ravi Billing', phone: '9000022222', staffUserId: 22,
      customerIds: [61], plotSiteIds: [30], isActive: true,
    });

    expect(response.status).toBe(201);
    expect(prisma.billingPerson.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        userId: 22, tenantId: 7, email: 'ravi@example.com',
        customerIdsJson: '[61]', plotSiteIdsJson: '[30]',
      }),
    }));
  });

  test('creates a billing staff login under the Billing role instead of Admin or User', async () => {
    prisma.role.findMany.mockResolvedValue([
      { id: 1, key: 'ADMIN', name: 'Admin', permissions: [{ module: 'billing_workspace', action: 'read' }] },
      { id: 3, key: 'USER', name: 'User', permissions: [{ module: 'billing_workspace', action: 'read' }] },
      { id: 9, key: 'BILLING', name: 'Billing Department', permissions: [{ module: 'billing_workspace', action: 'read' }] },
    ]);
    prisma.user.findFirst.mockResolvedValue(null);
    prisma.user.create.mockResolvedValue({ id: 23 });
    prisma.billingPerson.create.mockResolvedValue({
      id: 73, userId: 23, name: 'Meera Billing', phone: '9000066666',
      email: 'meera@example.com', isActive: true,
    });

    const response = await request(makeApp()).post('/api/pickup-plot-inventory/billing-persons').send({
      name: 'Meera Billing', phone: '9000066666', email: 'meera@example.com', password: 'secret123',
    });

    expect(response.status, JSON.stringify(response.body)).toBe(201);
    expect(prisma.userRole.create).toHaveBeenCalledWith({
      data: { userId: 23, roleId: 9, assignedById: 3 },
    });
  });

  test('does not let an unlinked user open a broker workspace', async () => {
    prisma.plotBroker.findFirst.mockResolvedValue(null);
    const response = await request(makeApp({ role: 'USER' })).get('/api/pickup-plot-inventory/brokers/me');
    expect(response.status).toBe(403);
    expect(response.body.code).toBe('BROKER_PROFILE_NOT_LINKED');
  });

  test('lists unlinked staff with Site Visits Workspace access regardless of role name', async () => {
    prisma.role.findMany.mockResolvedValue([{ id: 8, key: 'CUSTOM_FIELD_TEAM', name: 'Customer Field Team', permissions: [{ module: 'broker_workspace', action: 'read' }] }]);
    prisma.plotBroker.findMany.mockResolvedValue([{
      id: 51, userId: 17, name: 'Asha Rao', phone: '9000022222', isActive: true,
      plotSiteIdsJson: null, customerIdsJson: null,
    }]);
    prisma.customerPickup.findMany.mockResolvedValue([{
      contact: { id: 61, name: 'Priya Lead', phone: '9000055555' },
    }]);
    prisma.user.findMany.mockResolvedValue([
      { id: 17, name: 'Asha Rao', email: 'asha@example.com', phone: '9000022222' },
      { id: 18, name: 'Sanjeev Rao', email: 'sanjeev@example.com', phone: '9000033333' },
    ]);

    const response = await request(makeApp()).get('/api/pickup-plot-inventory/brokers');

    expect(response.status).toBe(200);
    expect(response.body.staffRole).toMatchObject({ id: 8, key: 'CUSTOM_FIELD_TEAM' });
    expect(response.body.staffUsers).toEqual([
      expect.objectContaining({ id: 18, email: 'sanjeev@example.com' }),
    ]);
    expect(response.body.customers).toEqual([
      expect.objectContaining({ id: 61, name: 'Priya Lead' }),
    ]);
    expect(prisma.user.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ tenantId: 7, userRoles: { some: { role: { permissions: { some: { module: 'broker_workspace', action: 'read' } } } } } }),
    }));
  });

  test('links existing staff with Site Visits Workspace access to a broker profile', async () => {
    prisma.user.findFirst.mockResolvedValue({
      id: 18, name: 'Sanjeev Rao', email: 'sanjeev@example.com', phone: '9000033333',
      userRoles: [{ role: { id: 8, key: 'FIELD_TEAM', name: 'Field Team', permissions: [{ module: 'broker_workspace', action: 'read' }] } }],
    });
    prisma.plotBroker.findFirst.mockResolvedValue(null);
    prisma.plotBroker.create.mockResolvedValue({
      id: 52, userId: 18, name: 'Sanjeev Rao', phone: '9000033333',
      email: 'sanjeev@example.com', plotSiteIdsJson: null, customerIdsJson: null,
    });

    const response = await request(makeApp()).post('/api/pickup-plot-inventory/brokers').send({
      name: 'Sanjeev Rao', phone: '9000033333', staffUserId: 18,
    });

    expect(response.status).toBe(201);
    expect(prisma.plotBroker.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ userId: 18, email: 'sanjeev@example.com', tenantId: 7 }),
    }));
  });

  test('creates a broker staff login and profile together with a password', async () => {
    prisma.role.findMany.mockResolvedValue([
      { id: 1, key: 'ADMIN', name: 'Admin', permissions: [{ module: 'broker_workspace', action: 'read' }] },
      { id: 3, key: 'USER', name: 'User', permissions: [{ module: 'broker_workspace', action: 'read' }] },
      { id: 8, key: 'BROOKER', name: 'BROOKER', permissions: [{ module: 'broker_workspace', action: 'read' }] },
    ]);
    prisma.user.findFirst.mockResolvedValue(null);
    prisma.user.create.mockResolvedValue({ id: 19 });
    prisma.plotBroker.create.mockResolvedValue({
      id: 53, userId: 19, name: 'Vikram Rao', phone: '9000044444',
      email: 'vikram@example.com', plotSiteIdsJson: null, customerIdsJson: null,
    });

    const response = await request(makeApp()).post('/api/pickup-plot-inventory/brokers').send({
      name: 'Vikram Rao', phone: '9000044444', email: 'vikram@example.com', password: 'secret123',
    });

    expect(response.status).toBe(201);
    expect(prisma.user.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        name: 'Vikram Rao', email: 'vikram@example.com', role: 'USER', userType: 'STAFF', tenantId: 7,
      }),
    }));
    expect(prisma.userRole.create).toHaveBeenCalledWith({
      data: { userId: 19, roleId: 8, assignedById: 3 },
    });
    expect(prisma.plotBroker.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ userId: 19, email: 'vikram@example.com', tenantId: 7 }),
    }));
  });

  test('creates a broker assigned to tenant-owned plots and customers', async () => {
    prisma.plotSite.findMany.mockResolvedValue([{ id: 30 }, { id: 31 }]);
    prisma.contact.findMany.mockResolvedValue([{ id: 61 }, { id: 62 }]);
    prisma.transportPerson.findMany.mockResolvedValue([{
      assignmentPairsJson: '[{"customerId":61,"plotSiteId":30},{"customerId":62,"plotSiteId":31}]',
    }]);
    prisma.plotBroker.create.mockResolvedValue({ id: 51, name: 'Asha', phone: '9000022222', plotSiteId: 30, plotSiteIdsJson: '[30,31]', customerIdsJson: '[61,62]' });
    const response = await request(makeApp()).post('/api/pickup-plot-inventory/brokers').send({
      name: 'Asha', phone: '9000022222', agency: 'Prime Plots', commissionPercent: '2.5', plotSiteIds: [30, 31],
      customerIds: [61, 62],
    });
    expect(response.status).toBe(201);
    expect(prisma.plotSite.findMany).toHaveBeenCalledWith({ where: { id: { in: [30, 31] }, tenantId: 7 }, select: { id: true } });
    expect(prisma.plotBroker.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({
      name: 'Asha', commissionPercent: 2.5, plotSiteId: 30, plotSiteIdsJson: '[30,31]', customerIdsJson: '[61,62]',
      assignmentPairsJson: '[{"customerId":61,"plotSiteId":30},{"customerId":62,"plotSiteId":31}]', tenantId: 7,
    }) }));
    expect(response.body.plotSiteIds).toEqual([30, 31]);
    expect(response.body.customerIds).toEqual([61, 62]);
  });

  test('rejects a broker commission above 100 percent', async () => {
    const response = await request(makeApp()).post('/api/pickup-plot-inventory/brokers').send({
      name: 'Asha', phone: '9000022222', commissionPercent: '101',
    });
    expect(response.status).toBe(400);
    expect(response.body.code).toBe('VALIDATION_ERROR');
    expect(prisma.plotBroker.create).not.toHaveBeenCalled();
  });

  test('rejects digits in a broker name and letters in a phone number', async () => {
    const invalidName = await request(makeApp()).post('/api/pickup-plot-inventory/brokers').send({
      name: 'vcgttg334534', phone: '9000022222',
    });
    expect(invalidName.status).toBe(400);
    expect(invalidName.body.error).toMatch(/only letters/);

    const invalidPhone = await request(makeApp()).post('/api/pickup-plot-inventory/brokers').send({
      name: 'Asha Rao', phone: 'dfgftg223125',
    });
    expect(invalidPhone.status).toBe(400);
    expect(invalidPhone.body.error).toMatch(/invalid characters/);
    expect(prisma.plotBroker.create).not.toHaveBeenCalled();
  });

  test('rejects an invalid broker email', async () => {
    const response = await request(makeApp()).post('/api/pickup-plot-inventory/brokers').send({
      name: 'Asha Rao', phone: '9000022222', email: 'wrong@address', commissionPercent: '2.5',
    });
    expect(response.status).toBe(400);
    expect(response.body.error).toMatch(/valid email/);
    expect(prisma.plotBroker.create).not.toHaveBeenCalled();
  });
});

describe('pickup and plot inventory tenant/vertical isolation', () => {
  test('rejects a non-generic tenant before reading inventory', async () => {
    prisma.tenant.findFirst.mockResolvedValue({ vertical: 'wellness' });
    const response = await request(makeApp()).get('/api/pickup-plot-inventory');
    expect(response.status).toBe(403);
    expect(response.body.code).toBe('GENERIC_ONLY');
    expect(prisma.pickupLocation.findMany).not.toHaveBeenCalled();
  });

  test('lists both inventories under the authenticated tenant and calculates summary', async () => {
    prisma.pickupLocation.findMany.mockResolvedValue([
      { id: 1, name: 'North Gate', isActive: true, _count: { plots: 2 } },
      { id: 2, name: 'Old Gate', isActive: false, _count: { plots: 1 } },
    ]);
    prisma.plotSite.findMany.mockResolvedValue([
      { id: 11, name: 'A-11', isActive: true, availability: 'AVAILABLE' },
      { id: 12, name: 'A-12', isActive: true, availability: 'RESERVED' },
      { id: 13, name: 'A-13', isActive: false, availability: 'SOLD' },
    ]);
    prisma.customerPickup.findMany.mockResolvedValue([
      { id: 81, contactId: 61, contact: { id: 61, name: 'Priya Shah', phone: '9000022222', email: 'priya@example.com' } },
    ]);
    prisma.plotBooking.findMany.mockResolvedValue([
      { contactId: 61, plotSiteId: 11 },
    ]);

    const response = await request(makeApp({ tenantId: 7 })).get('/api/pickup-plot-inventory');
    expect(response.status).toBe(200);
    expect(response.body.pickupLocations[0].plotCount).toBe(2);
    expect(response.body.pickupLocations[0].assignedCount).toBe(2);
    expect(response.body.plots[0].assignedCustomers).toEqual([
      expect.objectContaining({ id: 61, name: 'Priya Shah' }),
    ]);
    expect(response.body.customers).toEqual([
      expect.objectContaining({
        id: 81,
        contact: expect.objectContaining({ id: 61, name: 'Priya Shah' }),
        assignedPlotIds: [11],
      }),
    ]);
    expect(response.body.summary).toEqual({
      activeLocations: 1, totalPlots: 2, availablePlots: 1, reservedPlots: 1, soldPlots: 0,
    });
    expect(prisma.pickupLocation.findMany.mock.calls[0][0].where).toEqual({ tenantId: 7 });
    expect(prisma.plotSite.findMany.mock.calls[0][0].where).toEqual({ tenantId: 7 });
    expect(prisma.customerPickup.findMany.mock.calls[0][0].where).toEqual({
      tenantId: 7, contact: { deletedAt: null },
    });
    expect(prisma.plotBooking.findMany.mock.calls[0][0].where).toEqual({
      tenantId: 7, status: { not: 'CANCELLED' },
    });
  });
});

describe('Generic CRM transport and Sales Executive calling', () => {
  const assignedProfile = {
    id: 41,
    customerIdsJson: '[61]',
    plotSiteIdsJson: '[30]',
    assignmentPairsJson: '[{"customerId":61,"plotSiteId":30}]',
  };
  const customer = { id: 61, name: 'Priya Shah', phone: '9000022222', email: 'priya@example.com', company: 'Acme' };

  test('loads the Callified context only for a customer assigned to the signed-in workspace user', async () => {
    prisma.transportPerson.findFirst.mockResolvedValue(assignedProfile);
    prisma.plotBroker.findFirst.mockResolvedValue(null);
    prisma.contact.findFirst.mockResolvedValue(customer);

    const response = await request(makeApp({ role: 'USER' }))
      .get('/api/pickup-plot-inventory/calling/customers/61/context');

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ contactId: 61, patientName: 'Priya Shah', phoneValid: true });
    expect(prisma.contact.findFirst).toHaveBeenCalledWith({
      where: { id: 61, tenantId: 7, deletedAt: null },
      select: { id: true, name: true, phone: true, email: true, company: true },
    });
  });

  test('does not expose an unassigned customer to a workspace user', async () => {
    prisma.transportPerson.findFirst.mockResolvedValue({ ...assignedProfile, assignmentPairsJson: '[]', customerIdsJson: '[]' });
    prisma.plotBroker.findFirst.mockResolvedValue(null);

    const response = await request(makeApp({ role: 'USER' }))
      .get('/api/pickup-plot-inventory/calling/customers/61/context');

    expect(response.status).toBe(404);
    expect(response.body.code).toBe('CALLING_CUSTOMER_NOT_FOUND');
    expect(prisma.contact.findFirst).not.toHaveBeenCalled();
  });

  test('starts an AI call for an assigned customer with the selected campaign', async () => {
    prisma.transportPerson.findFirst.mockResolvedValue(assignedProfile);
    prisma.plotBroker.findFirst.mockResolvedValue(null);
    prisma.contact.findFirst.mockResolvedValue(customer);

    const response = await request(makeApp({ role: 'USER' }))
      .post('/api/pickup-plot-inventory/calling/customers/61/ai-call')
      .send({ campaignId: 77 });

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(callifiedClient.initiateCallForContact).toHaveBeenCalledWith({
      tenantId: 7, contactId: 61, campaignId: 77, userId: 3,
      interest: 'Generic CRM pickup and plot customer',
    });
    expect(audit.writeAudit).toHaveBeenCalledWith(
      'CallifiedCall', 'INITIATE', '901', 3, 7,
      expect.objectContaining({ surface: 'generic_pickup_plot_workspace', mode: 'ai', contactId: 61, campaignId: 77 }),
    );
  });

  test('starts a manual browser call for an assigned customer', async () => {
    prisma.plotBroker.findFirst.mockResolvedValue(assignedProfile);
    prisma.transportPerson.findFirst.mockResolvedValue(null);
    prisma.contact.findFirst.mockResolvedValue(customer);

    const response = await request(makeApp({ role: 'USER' }))
      .post('/api/pickup-plot-inventory/calling/customers/61/manual-call')
      .send({ campaignId: 88 });

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(callifiedBridge.startBrowserCall).toHaveBeenCalledWith({
      tenantId: 7, contactId: 61, campaignId: 88, userId: 3,
      interest: 'Generic CRM pickup and plot customer',
    });
    expect(response.body).toMatchObject({ callifiedLeadId: 902, callSid: 'call-manual-1', contactId: 61 });
  });
});

describe('pickup location mutations', () => {
  test('imports pickup locations by updating matching names and creating new rows', async () => {
    prisma.pickupLocation.findMany.mockResolvedValue([{ id: 20, name: 'Main Gate' }]);
    prisma.pickupLocation.create.mockResolvedValue({ id: 21, name: 'South Gate' });

    const response = await request(makeApp()).post('/api/pickup-plot-inventory/locations/import').send({
      rows: [
        { name: 'Main Gate', address: '11 Updated Market Road', maxAssignments: '25', isActive: 'TRUE' },
        { name: 'South Gate', address: '12 Market Road', maxAssignments: '', isActive: 'FALSE' },
      ],
    });

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body).toEqual({ total: 2, created: 1, updated: 1 });
    expect(prisma.pickupLocation.findMany).toHaveBeenCalledWith({
      where: { tenantId: 7 }, select: { id: true, name: true },
    });
    expect(prisma.pickupLocation.update).toHaveBeenCalledWith({
      where: { id: 20 }, data: expect.objectContaining({ address: '11 Updated Market Road', maxAssignments: 25, isActive: true }),
    });
    expect(prisma.pickupLocation.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ name: 'South Gate', tenantId: 7, maxAssignments: null, isActive: false }),
    });
  });

  test('defaults pickup imports without Notes or Active to empty notes and active inventory', async () => {
    prisma.pickupLocation.findMany.mockResolvedValue([]);
    prisma.pickupLocation.create.mockResolvedValue({ id: 21, name: 'South Gate' });

    const response = await request(makeApp()).post('/api/pickup-plot-inventory/locations/import').send({
      rows: [{
        name: 'South Gate', address: '18 Residency Road, Bengaluru',
        googleMapsLink: '', maxAssignments: '12',
      }],
    });

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(prisma.pickupLocation.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ notes: null, isActive: true, tenantId: 7 }),
    });
  });

  test('rejects the complete pickup import when any row is invalid', async () => {
    const response = await request(makeApp()).post('/api/pickup-plot-inventory/locations/import').send({
      rows: [{ name: 'Bad Gate', address: 'x', isActive: 'sometimes' }],
    });
    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ code: 'IMPORT_VALIDATION_ERROR', errors: [{ row: 2 }] });
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.pickupLocation.create).not.toHaveBeenCalled();
  });

  test('creates a tenant-scoped location with a Google Maps link', async () => {
    prisma.pickupLocation.create.mockResolvedValue({ id: 20, name: 'Main Gate', isActive: true });
    const response = await request(makeApp()).post('/api/pickup-plot-inventory/locations').send({
      name: ' Main Gate ', address: ' 10 Market Road ',
      googleMapsLink: 'https://maps.google.com/?q=12,77', maxAssignments: 12, isActive: true,
    });
    expect(response.status).toBe(201);
    expect(prisma.pickupLocation.create).toHaveBeenCalledWith({ data: expect.objectContaining({
      name: 'Main Gate', address: '10 Market Road', tenantId: 7,
      googleMapsLink: 'https://maps.google.com/?q=12,77',
      maxAssignments: 12,
    }) });
  });

  test('updates the maximum assignment limit for a pickup location', async () => {
    prisma.pickupLocation.findFirst.mockResolvedValue({
      id: 20, tenantId: 7, name: 'Main Gate', address: '10 Market Road', isActive: true,
    });
    prisma.pickupLocation.update.mockResolvedValue({
      id: 20, name: 'Main Gate', address: '10 Market Road', maxAssignments: 25, isActive: true,
    });

    const response = await request(makeApp()).put('/api/pickup-plot-inventory/locations/20').send({
      name: 'Main Gate', address: '10 Market Road', maxAssignments: 25, isActive: true,
    });

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(prisma.pickupLocation.update).toHaveBeenCalledWith({
      where: { id: 20 },
      data: expect.objectContaining({ maxAssignments: 25 }),
    });
  });

  test('rejects an invalid maximum assignment limit', async () => {
    const response = await request(makeApp()).post('/api/pickup-plot-inventory/locations').send({
      name: 'Main Gate', address: '10 Market Road', maxAssignments: 0,
    });
    expect(response.status).toBe(400);
    expect(response.body.error).toMatch(/positive whole number/i);
  });

  test('rejects a non-Google or non-HTTPS maps link', async () => {
    const response = await request(makeApp()).post('/api/pickup-plot-inventory/locations').send({
      name: 'Main Gate', address: '10 Market Road', googleMapsLink: 'https://example.com/map',
    });
    expect(response.status).toBe(400);
    expect(response.body.code).toBe('INVALID_MAPS_LINK');
  });

  test('does not update a location from another tenant', async () => {
    prisma.pickupLocation.findFirst.mockResolvedValue(null);
    const response = await request(makeApp({ tenantId: 9 })).put('/api/pickup-plot-inventory/locations/22').send({ name: 'X', address: 'Y' });
    expect(response.status).toBe(404);
    expect(prisma.pickupLocation.findFirst).toHaveBeenCalledWith({ where: { id: 22, tenantId: 9 } });
    expect(prisma.pickupLocation.update).not.toHaveBeenCalled();
  });

  test('requires ADMIN for location changes', async () => {
    const response = await request(makeApp({ role: 'MANAGER' })).post('/api/pickup-plot-inventory/locations').send({ name: 'X', address: 'Y' });
    expect(response.status).toBe(403);
    expect(prisma.pickupLocation.create).not.toHaveBeenCalled();
  });
});

describe('plot/site mutations', () => {
  const requiredPlotFields = {
    name: 'Plot A-1', plotNumber: 'A-1', block: 'A', address: '25 Lake Road',
    area: '1200', areaUnit: 'SQ_FT', price: '250000', roadWidth: '30 ft',
    propertyType: 'RESIDENTIAL', availability: 'AVAILABLE', notes: '', isActive: true,
  };

  test('imports plots with tenant pickup-location names and upserts by name and plot number', async () => {
    prisma.pickupLocation.findMany.mockResolvedValue([{ id: 4, name: 'North Gate' }]);
    prisma.plotSite.findMany.mockResolvedValue([{ id: 30, name: 'Plot A-1', plotNumber: 'A-1' }]);
    prisma.plotSite.create.mockResolvedValue({ id: 31, name: 'Plot A-2', plotNumber: 'A-2' });
    const rows = [
      { ...requiredPlotFields, pickupLocationNames: 'North Gate' },
      { ...requiredPlotFields, plotNumber: 'A-2', pickupLocationNames: 'North Gate', isActive: 'FALSE' },
    ];

    const response = await request(makeApp()).post('/api/pickup-plot-inventory/plots/import').send({ rows });

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body).toEqual({ total: 2, created: 1, updated: 1 });
    expect(prisma.plotSite.update).toHaveBeenCalledWith({
      where: { id: 30 },
      data: expect.objectContaining({ pickupLocationId: 4, pickupLocationIdsJson: '[4]', isActive: true }),
    });
    expect(prisma.plotSite.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ plotNumber: 'A-2', pickupLocationId: 4, tenantId: 7, isActive: false }),
    });
  });

  test('defaults template imports without Notes or Active to blank notes and active inventory', async () => {
    prisma.pickupLocation.findMany.mockResolvedValue([{ id: 4, name: 'North Gate' }]);
    prisma.plotSite.findMany.mockResolvedValue([]);
    prisma.plotSite.create.mockResolvedValue({ id: 31, name: 'Plot A-1', plotNumber: 'A-1' });

    const response = await request(makeApp()).post('/api/pickup-plot-inventory/plots/import').send({
      rows: [{
        name: 'Plot A-1', plotNumber: 'A-1', block: 'A', address: '25 Lake Road',
        pickupLocationNames: 'North Gate', area: '1200', areaUnit: 'SQ_FT',
        price: '250000', availability: 'AVAILABLE', roadWidth: '30 ft',
        facing: 'EAST', propertyType: 'RESIDENTIAL',
      }],
    });

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(prisma.plotSite.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ notes: null, isActive: true, tenantId: 7 }),
    });
  });

  test('returns the spreadsheet row number when an imported pickup location is unknown', async () => {
    prisma.pickupLocation.findMany.mockResolvedValue([]);
    const response = await request(makeApp()).post('/api/pickup-plot-inventory/plots/import').send({
      rows: [{ ...requiredPlotFields, pickupLocationNames: 'Missing Gate' }],
    });
    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      code: 'IMPORT_VALIDATION_ERROR',
      errors: [{ row: 2, error: 'Pickup location "Missing Gate" was not found.' }],
    });
    expect(prisma.plotSite.create).not.toHaveBeenCalled();
  });

  test.each([
    ['plotNumber', 'Plot number'], ['block', 'Block'], ['address', 'Address'],
    ['area', 'Area or size'], ['areaUnit', 'Area unit'], ['price', 'Price'],
    ['roadWidth', 'Road width'], ['propertyType', 'Residential / Commercial'],
    ['availability', 'Availability'],
  ])('rejects a blank required %s', async (field, label) => {
    const response = await request(makeApp()).post('/api/pickup-plot-inventory/plots').send({
      ...requiredPlotFields,
      [field]: '',
    });
    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ error: `${label} is required.`, code: 'VALIDATION_ERROR' });
    expect(prisma.plotSite.create).not.toHaveBeenCalled();
  });

  test('creates an available plot linked only to a location in the same tenant', async () => {
    prisma.pickupLocation.findMany.mockResolvedValue([{ id: 4 }]);
    prisma.plotSite.create.mockResolvedValue({ id: 30, name: 'Plot 30' });
    const response = await request(makeApp()).post('/api/pickup-plot-inventory/plots').send({
      ...requiredPlotFields, name: 'Plot 30', pickupLocationId: 4, referenceCode: 'P-30',
    });
    expect(response.status).toBe(201);
    expect(prisma.pickupLocation.findMany).toHaveBeenCalledWith({ where: { id: { in: [4] }, tenantId: 7 }, select: { id: true } });
    expect(prisma.plotSite.create).toHaveBeenCalledWith({ data: expect.objectContaining({
      name: 'Plot 30', pickupLocationId: 4, price: 250000, tenantId: 7,
    }) });
  });

  test('rejects a duplicate plot number under the same plot name', async () => {
    prisma.plotSite.findFirst.mockResolvedValue({ id: 29 });

    const response = await request(makeApp()).post('/api/pickup-plot-inventory/plots').send({
      ...requiredPlotFields,
      name: 'Plot A-1',
      plotNumber: 'A-1',
      block: 'A',
    });

    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({ code: 'DUPLICATE_PLOT_NUMBER' });
    expect(prisma.plotSite.findFirst).toHaveBeenCalledWith({
      where: { tenantId: 7, name: 'Plot A-1', plotNumber: 'A-1' },
      select: { id: true },
    });
    expect(prisma.plotSite.create).not.toHaveBeenCalled();
  });

  test('allows the same plot name and block when the plot number is different', async () => {
    prisma.plotSite.findFirst.mockResolvedValue(null);
    prisma.plotSite.create.mockImplementation(async ({ data }) => ({ id: 31, ...data }));

    const response = await request(makeApp()).post('/api/pickup-plot-inventory/plots').send({
      ...requiredPlotFields,
      name: 'Plot A-1',
      plotNumber: 'A-2',
      block: 'A',
    });

    expect(response.status).toBe(201);
    expect(prisma.plotSite.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ name: 'Plot A-1', plotNumber: 'A-2', block: 'A' }),
    });
  });

  test('rejects changing a plot to another row\'s number under the same plot name', async () => {
    prisma.plotSite.findFirst
      .mockResolvedValueOnce({ id: 30, tenantId: 7, isActive: true })
      .mockResolvedValueOnce({ id: 29 });

    const response = await request(makeApp()).put('/api/pickup-plot-inventory/plots/30').send({
      ...requiredPlotFields,
      name: 'Plot A-1',
      plotNumber: 'A-2',
      block: 'A',
    });

    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({ code: 'DUPLICATE_PLOT_NUMBER' });
    expect(prisma.plotSite.findFirst).toHaveBeenNthCalledWith(2, {
      where: { tenantId: 7, name: 'Plot A-1', plotNumber: 'A-2', id: { not: 30 } },
      select: { id: true },
    });
    expect(prisma.plotSite.update).not.toHaveBeenCalled();
  });

  test('stores interactive master-plan plot details and the new availability values', async () => {
    prisma.plotSite.create.mockImplementation(async ({ data }) => ({ id: 32, ...data }));
    const response = await request(makeApp()).post('/api/pickup-plot-inventory/plots').send({
      ...requiredPlotFields,
      name: 'Plot A-10', plotNumber: 'A-10', block: 'A', area: '2', areaUnit: 'KATHA',
      price: '350000', roadWidth: '30 ft', facing: 'EAST', propertyType: 'RESIDENTIAL',
      availability: 'BOOKED',
    });

    expect(response.status).toBe(201);
    expect(prisma.plotSite.create).toHaveBeenCalledWith({ data: expect.objectContaining({
      plotNumber: 'A-10', block: 'A', area: '2', areaUnit: 'KATHA', price: 350000,
      roadWidth: '30 ft', facing: 'EAST', propertyType: 'RESIDENTIAL', availability: 'BOOKED',
    }) });
  });

  test('stores a sanitized GPS boundary and calculates its square-foot area server-side', async () => {
    prisma.plotSite.create.mockImplementation(async ({ data }) => ({ id: 31, ...data }));
    const boundary = [
      { latitude: 12.935, longitude: 77.61 },
      { latitude: 12.935, longitude: 77.6101 },
      { latitude: 12.9351, longitude: 77.6101 },
      { latitude: 12.9351, longitude: 77.61 },
    ];
    const response = await request(makeApp()).post('/api/pickup-plot-inventory/plots').send({
      ...requiredPlotFields, name: 'Surveyed Plot', boundary,
    });

    expect(response.status).toBe(201);
    const write = prisma.plotSite.create.mock.calls[0][0].data;
    expect(JSON.parse(write.boundaryJson)).toEqual(boundary);
    expect(write.boundaryAreaSqFt).toBeGreaterThan(1200);
    expect(response.body.boundary).toEqual(boundary);
    expect(response.body).not.toHaveProperty('boundaryJson');
  });

  test('rejects a malformed or incomplete GPS boundary', async () => {
    const response = await request(makeApp()).post('/api/pickup-plot-inventory/plots').send({
      name: 'Broken Plot', availability: 'AVAILABLE',
      boundary: [[12.935, 77.61], [12.936, 77.611]],
    });
    expect(response.status).toBe(400);
    expect(response.body.code).toBe('INVALID_BOUNDARY');
    expect(prisma.plotSite.create).not.toHaveBeenCalled();
  });

  test('rejects an invalid availability value', async () => {
    const response = await request(makeApp()).post('/api/pickup-plot-inventory/plots').send({
      ...requiredPlotFields, name: 'Plot X', availability: 'HIDDEN',
    });
    expect(response.status).toBe(400);
    expect(response.body.code).toBe('VALIDATION_ERROR');
  });

  test('status changes are tenant scoped', async () => {
    prisma.plotSite.findFirst.mockResolvedValue({ id: 30, tenantId: 7, isActive: true });
    prisma.plotSite.update.mockResolvedValue({ id: 30, isActive: false });
    const response = await request(makeApp()).patch('/api/pickup-plot-inventory/plots/30/status').send({ isActive: false });
    expect(response.status).toBe(200);
    expect(prisma.plotSite.findFirst).toHaveBeenCalledWith({ where: { id: 30, tenantId: 7 } });
    expect(prisma.plotSite.update).toHaveBeenCalledWith({ where: { id: 30 }, data: { isActive: false } });
  });
});

describe('customer pickup status', () => {
  test('saves a tenant-scoped pickup address selected from a Callified transcript', async () => {
    prisma.contact.findFirst.mockResolvedValue({ id: 61 });
    prisma.customerPickup.upsert.mockResolvedValue({
      id: 91, tenantId: 7, contactId: 61, pickupAddress: '42 Lake View Road, Bengaluru',
      sourceTranscriptId: '789', contact: { id: 61, name: 'Priya Shah' },
    });

    const response = await request(makeApp({ role: 'USER' }))
      .put('/api/pickup-plot-inventory/customer-pickups/61')
      .send({
        pickupAddress: ' 42 Lake View Road, Bengaluru; is that correct? ',
        sourceTranscriptId: '789',
        sourceExcerpt: 'My pickup location is 42 Lake View Road, Bengaluru.',
      });

    expect(response.status).toBe(200);
    expect(prisma.contact.findFirst).toHaveBeenCalledWith({
      where: { id: 61, tenantId: 7, deletedAt: null, assignedToId: 3 }, select: { id: true },
    });
    expect(prisma.customerPickup.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { tenantId_contactId: { tenantId: 7, contactId: 61 } },
      create: expect.objectContaining({
        tenantId: 7, contactId: 61, pickupAddress: '42 Lake View Road, Bengaluru',
        sourceTranscriptId: '789', capturedByUserId: 3,
      }),
    }));
    expect(response.body.status).toBe('PICKUP_LOCATION_CAPTURED');
    expect(eventBus.emitEvent).toHaveBeenCalledWith(
      'pickup_point.created',
      expect.objectContaining({
        pickupPointId: 91,
        contactId: 61,
        eventId: expect.stringMatching(/^91-\d+$/),
      }),
      7,
      undefined,
    );
    expect(assignmentWhatsApp.safeNotifyCustomerPickupPlotAssignments).toHaveBeenCalledWith({
      tenantId: 7,
      contactId: 61,
    });
  });

  test('emits the same sequence trigger path when an existing pickup location changes', async () => {
    prisma.contact.findFirst.mockResolvedValue({ id: 61 });
    prisma.customerPickup.findUnique.mockResolvedValue({ id: 91 });
    prisma.customerPickup.upsert.mockResolvedValue({
      id: 91, tenantId: 7, contactId: 61, pickupAddress: '55 New Pickup Road, Bengaluru',
      updatedAt: new Date('2026-10-23T08:00:00.000Z'), contact: { id: 61, name: 'Priya Shah' },
    });

    const response = await request(makeApp())
      .put('/api/pickup-plot-inventory/customer-pickups/61')
      .send({ pickupAddress: '55 New Pickup Road, Bengaluru' });

    expect(response.status).toBe(200);
    expect(eventBus.emitEvent).toHaveBeenCalledWith(
      'pickup_point.updated',
      expect.objectContaining({
        pickupPointId: 91,
        contactId: 61,
        eventId: '91-1792742400000',
      }),
      7,
      undefined,
    );
  });

  test('prevents a USER from changing another user\'s pickup location', async () => {
    prisma.contact.findFirst.mockResolvedValue(null);

    const response = await request(makeApp({ role: 'USER' }))
      .put('/api/pickup-plot-inventory/customer-pickups/61')
      .send({ pickupAddress: '42 Lake View Road, Bengaluru' });

    expect(response.status).toBe(404);
    expect(prisma.contact.findFirst).toHaveBeenCalledWith({
      where: { id: 61, tenantId: 7, deletedAt: null, assignedToId: 3 }, select: { id: true },
    });
    expect(prisma.customerPickup.upsert).not.toHaveBeenCalled();
  });

  test('prevents changing the pickup location after transport is assigned', async () => {
    prisma.contact.findFirst.mockResolvedValue({ id: 61 });
    prisma.transportPerson.findMany.mockResolvedValue([{
      customerIdsJson: '[61]',
      plotSiteIdsJson: '[30]',
      assignmentPairsJson: '[{"customerId":61,"plotSiteId":30}]',
    }]);

    const response = await request(makeApp())
      .put('/api/pickup-plot-inventory/customer-pickups/61')
      .send({ pickupAddress: '55 New Pickup Road, Bengaluru' });

    expect(response.status).toBe(409);
    expect(response.body.code).toBe('TRANSPORT_WORKFLOW_LOCKED');
    expect(prisma.customerPickup.upsert).not.toHaveBeenCalled();
  });

  test('assigns multiple available plots to one customer atomically', async () => {
    prisma.contact.findFirst.mockResolvedValue({ id: 61 });
    prisma.customerPickup.findUnique.mockResolvedValue({ id: 91 });
    prisma.plotSite.findMany
      .mockResolvedValueOnce([
        { id: 31, name: 'North Avenue', plotNumber: '25', price: 4200000, availability: 'AVAILABLE' },
        { id: 32, name: 'North Avenue', plotNumber: '107', price: 5100000, availability: 'AVAILABLE' },
      ])
      .mockResolvedValueOnce([
        { id: 30, name: 'North Avenue', plotNumber: '24' },
      ]);
    prisma.plotBooking.findMany.mockResolvedValue([
      { id: 501, plotSiteId: 30, bookingNumber: 'BOOK-501', status: 'PLOT_RESERVED' },
    ]);
    prisma.plotBooking.create
      .mockResolvedValueOnce({ id: 502, plotSiteId: 31, bookingNumber: 'BOOK-502', status: 'PLOT_ASSIGNED' })
      .mockResolvedValueOnce({ id: 503, plotSiteId: 32, bookingNumber: 'BOOK-503', status: 'PLOT_ASSIGNED' });

    const response = await request(makeApp())
      .post('/api/pickup-plot-inventory/customer-pickups/61/plots')
      .send({ plotSiteIds: [31, 32, 32] });

    expect(response.status, JSON.stringify(response.body)).toBe(201);
    expect(response.body).toMatchObject({
      contactId: 61,
      assignedPlotIds: [30, 31, 32],
      bookingsCreated: 2,
    });
    expect(prisma.plotSite.updateMany).not.toHaveBeenCalled();
    expect(prisma.plotBooking.create).toHaveBeenCalledTimes(2);
    expect(prisma.plotBooking.create).toHaveBeenNthCalledWith(1, {
      data: expect.objectContaining({
        tenantId: 7, contactId: 61, customerPickupId: 91, plotSiteId: 31,
        status: 'PLOT_ASSIGNED', paymentStatus: 'UNPAID', totalAmount: 4200000, balance: 4200000,
      }),
    });
    expect(prisma.plotWorkflowEvent.create).toHaveBeenCalledTimes(2);
  });

  test('assigns a plot before the customer has a pickup location', async () => {
    prisma.contact.findFirst.mockResolvedValue({ id: 61 });
    prisma.customerPickup.findUnique.mockResolvedValue(null);
    prisma.plotSite.findMany.mockResolvedValue([
      { id: 31, name: 'North Avenue', plotNumber: '25', price: 4200000, availability: 'AVAILABLE' },
    ]);
    prisma.plotBooking.create.mockResolvedValue({
      id: 502, plotSiteId: 31, bookingNumber: 'BOOK-502', status: 'PLOT_ASSIGNED',
    });

    const response = await request(makeApp())
      .post('/api/pickup-plot-inventory/customer-pickups/61/plots')
      .send({ plotSiteIds: [31] });

    expect(response.status, JSON.stringify(response.body)).toBe(201);
    expect(prisma.plotBooking.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        tenantId: 7, contactId: 61, customerPickupId: null, plotSiteId: 31,
      }),
    });
  });

  test('prevents assigning or changing plots after transport is assigned', async () => {
    prisma.contact.findFirst.mockResolvedValue({ id: 61 });
    prisma.transportPerson.findMany.mockResolvedValue([{
      customerIdsJson: '[61]',
      plotSiteIdsJson: '[30]',
      assignmentPairsJson: '[{"customerId":61,"plotSiteId":30}]',
    }]);
    prisma.plotSite.findMany.mockResolvedValue([{
      id: 31, name: 'North Avenue', plotNumber: '25', price: 4200000, availability: 'AVAILABLE',
    }]);

    const response = await request(makeApp())
      .post('/api/pickup-plot-inventory/customer-pickups/61/plots')
      .send({ plotSiteIds: [31] });

    expect(response.status).toBe(409);
    expect(response.body.code).toBe('TRANSPORT_WORKFLOW_LOCKED');
    expect(prisma.plotBooking.create).not.toHaveBeenCalled();
  });

  test('deselects an unpaid plot assignment before its workflow starts', async () => {
    prisma.contact.findFirst.mockResolvedValue({ id: 61 });
    prisma.transportPerson.findMany.mockResolvedValue([]);
    prisma.plotBooking.findFirst.mockResolvedValue({
      id: 501, status: 'PLOT_ASSIGNED', paymentStatus: 'UNPAID', amountPaid: 0, invoiceId: null,
    });

    const response = await request(makeApp())
      .delete('/api/pickup-plot-inventory/customer-pickups/61/plots/30');

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body).toEqual({ contactId: 61, plotSiteId: 30, unassigned: true });
    expect(prisma.plotBooking.updateMany).toHaveBeenCalledWith({
      where: { id: { in: [501] }, tenantId: 7, contactId: 61, plotSiteId: 30, status: 'PLOT_ASSIGNED', paymentStatus: { in: ['', 'UNPAID'] }, amountPaid: 0, invoiceId: null }, data: { status: 'CANCELLED' },
    });
    expect(prisma.plotSite.updateMany).toHaveBeenCalledWith({
      where: { id: 30, tenantId: 7, availability: 'RESERVED' },
      data: { availability: 'AVAILABLE' },
    });
    expect(prisma.plotWorkflowEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        tenantId: 7, contactId: 61, plotSiteId: 30,
        eventType: 'CANCELLED', fromStatus: 'PLOT_ASSIGNED', toStatus: 'CANCELLED',
      }),
    });
  });

  test('does not cancel when payment or booking changes after the initial check', async () => {
    prisma.contact.findFirst.mockResolvedValue({ id: 61 });
    prisma.transportPerson.findMany.mockResolvedValue([]);
    prisma.plotBooking.findFirst.mockResolvedValue({ id: 501, status: 'PLOT_ASSIGNED', paymentStatus: 'UNPAID', amountPaid: 0, invoiceId: null });
    prisma.plotBooking.updateMany.mockResolvedValueOnce({ count: 0 });
    const response = await request(makeApp()).delete('/api/pickup-plot-inventory/customer-pickups/61/plots/30');
    expect(response.status).toBe(409);
    expect(response.body.code).toBe('PLOT_UNASSIGNMENT_LOCKED');
    expect(prisma.plotSite.updateMany).not.toHaveBeenCalled();
  });

  test('blocks deselection when another booking for the same customer and plot has progressed', async () => {
    prisma.contact.findFirst.mockResolvedValue({ id: 61 });
    prisma.plotBooking.findFirst.mockResolvedValue({ id: 501, status: 'PLOT_ASSIGNED', paymentStatus: 'UNPAID', amountPaid: 0, invoiceId: null });
    prisma.plotBooking.findMany.mockResolvedValue([
      { id: 501, contactId: 61, status: 'PLOT_ASSIGNED', paymentStatus: 'UNPAID', amountPaid: 0 },
      { id: 502, contactId: 61, status: 'INVOICE_CREATED', paymentStatus: 'UNPAID', amountPaid: 0, invoiceId: 701 },
    ]);
    const response = await request(makeApp()).delete('/api/pickup-plot-inventory/customer-pickups/61/plots/30');
    expect(response.status).toBe(409);
    expect(response.body.code).toBe('PLOT_UNASSIGNMENT_LOCKED');
    expect(prisma.plotBooking.updateMany).not.toHaveBeenCalled();
    expect(prisma.plotSite.updateMany).not.toHaveBeenCalled();
  });

  test('does not release a plot reserved by another customer booking', async () => {
    prisma.contact.findFirst.mockResolvedValue({ id: 61 });
    prisma.plotBooking.findFirst.mockResolvedValue({ id: 501, status: 'PLOT_ASSIGNED', paymentStatus: 'UNPAID', amountPaid: 0, invoiceId: null });
    prisma.plotBooking.findMany.mockResolvedValue([
      { id: 501, contactId: 61, status: 'PLOT_ASSIGNED', paymentStatus: 'UNPAID', amountPaid: 0 },
      { id: 502, contactId: 62, status: 'PLOT_RESERVED', paymentStatus: 'UNPAID', amountPaid: 0 },
    ]);
    const response = await request(makeApp()).delete('/api/pickup-plot-inventory/customer-pickups/61/plots/30');
    expect(response.status).toBe(200);
    expect(prisma.plotSite.updateMany).not.toHaveBeenCalled();
  });

  test('cancels all duplicate unpaid assignments for the customer and plot together', async () => {
    prisma.contact.findFirst.mockResolvedValue({ id: 61 });
    prisma.plotBooking.findFirst.mockResolvedValue({ id: 501, status: 'PLOT_ASSIGNED', paymentStatus: 'UNPAID', amountPaid: 0, invoiceId: null });
    prisma.plotBooking.findMany.mockResolvedValue([501, 502].map((id) => ({ id, contactId: 61, status: 'PLOT_ASSIGNED', paymentStatus: 'UNPAID', amountPaid: 0 })));
    prisma.plotBooking.updateMany.mockResolvedValueOnce({ count: 2 });
    const response = await request(makeApp()).delete('/api/pickup-plot-inventory/customer-pickups/61/plots/30');
    expect(response.status).toBe(200);
    expect(prisma.plotBooking.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ id: { in: [501, 502] }, tenantId: 7, contactId: 61, plotSiteId: 30 }) }));
  });

  test('rechecks transport assignments inside the cancellation transaction', async () => {
    prisma.contact.findFirst.mockResolvedValue({ id: 61 });
    prisma.plotBooking.findFirst.mockResolvedValue({ id: 501, status: 'PLOT_ASSIGNED', paymentStatus: 'UNPAID', amountPaid: 0, invoiceId: null });
    prisma.transportPerson.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([{ assignmentPairsJson: '[{"customerId":61,"plotSiteId":30}]' }]);
    const response = await request(makeApp()).delete('/api/pickup-plot-inventory/customer-pickups/61/plots/30');
    expect(response.status).toBe(409);
    expect(response.body.code).toBe('TRANSPORT_WORKFLOW_LOCKED');
    expect(prisma.plotBooking.updateMany).not.toHaveBeenCalled();
  });

  test('prevents deselecting a plot after its booking or payment workflow starts', async () => {
    prisma.contact.findFirst.mockResolvedValue({ id: 61 });
    prisma.transportPerson.findMany.mockResolvedValue([]);
    prisma.plotBooking.findFirst.mockResolvedValue({
      id: 501, status: 'PLOT_RESERVED', paymentStatus: 'PARTIALLY_PAID', amountPaid: 1000, invoiceId: 701,
    });

    const response = await request(makeApp())
      .delete('/api/pickup-plot-inventory/customer-pickups/61/plots/30');

    expect(response.status).toBe(409);
    expect(response.body.code).toBe('PLOT_UNASSIGNMENT_LOCKED');
    expect(prisma.plotBooking.update).not.toHaveBeenCalled();
  });

  test('replaces only the selected reserved plot and preserves the other assigned plot', async () => {
    prisma.contact.findFirst.mockResolvedValue({ id: 61 });
    prisma.customerPickup.findUnique.mockResolvedValue({ id: 91 });
    prisma.plotSite.findMany
      .mockResolvedValueOnce([
        { id: 33, name: 'Koramangala', plotNumber: '12', price: 4500000, availability: 'AVAILABLE' },
      ])
      .mockResolvedValueOnce([
        { id: 30, name: 'Koramangala', plotNumber: '10', availability: 'RESERVED' },
        { id: 31, name: 'Koramangala', plotNumber: '11', availability: 'RESERVED' },
      ]);
    prisma.plotBooking.findMany.mockResolvedValue([
      { id: 501, plotSiteId: 30, bookingNumber: 'BOOK-501', status: 'PLOT_RESERVED', invoiceId: 701 },
      { id: 502, plotSiteId: 31, bookingNumber: 'BOOK-502', status: 'PLOT_RESERVED', invoiceId: 702 },
    ]);
    prisma.transportPerson.findMany.mockResolvedValue([]);
    prisma.billingPerson.findMany.mockResolvedValue([]);
    prisma.plotBroker.findMany.mockResolvedValue([{
      id: 51, plotSiteId: 30, plotSiteIdsJson: '[30,31]',
      assignmentPairsJson: '[{"customerId":61,"plotSiteId":30},{"customerId":62,"plotSiteId":31}]',
      workflowStatusJson: '{"customer-61-plot-30":{"status":"PLOT_SELECTED","plotId":30}}',
    }]);

    const response = await request(makeApp())
      .post('/api/pickup-plot-inventory/customer-pickups/61/plots')
      .send({ plotSiteIds: [33], replacePlotSiteId: 30 });

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body).toMatchObject({
      replacedPlotSiteId: 30,
      replacementPlotSiteId: 33,
      assignedPlotIds: [33, 31],
      bookingsUpdated: 1,
    });
    expect(prisma.plotBooking.update).toHaveBeenCalledTimes(1);
    expect(prisma.plotBooking.update).toHaveBeenCalledWith({
      where: { id: 501 }, data: { plotSiteId: 33 },
    });
    expect(prisma.plotInvoiceItem.updateMany).toHaveBeenCalledWith({
      where: { tenantId: 7, plotBookingId: 501 },
      data: { itemId: 33, description: 'Koramangala' },
    });
    const brokerUpdate = prisma.plotBroker.update.mock.calls[0][0];
    expect(JSON.parse(brokerUpdate.data.assignmentPairsJson)).toEqual([
      { customerId: 61, plotSiteId: 33 },
      { customerId: 62, plotSiteId: 31 },
    ]);
    expect(JSON.parse(brokerUpdate.data.workflowStatusJson)).toEqual({
      'customer-61-plot-33': { status: 'PLOT_SELECTED', plotId: 33 },
    });
  });

  test('prevents changing a purchased plot', async () => {
    prisma.contact.findFirst.mockResolvedValue({ id: 61 });
    prisma.customerPickup.findUnique.mockResolvedValue({ id: 91 });
    prisma.plotSite.findMany
      .mockResolvedValueOnce([
        { id: 33, name: 'Koramangala', plotNumber: '12', price: 4500000, availability: 'AVAILABLE' },
      ])
      .mockResolvedValueOnce([
        { id: 30, name: 'Koramangala', plotNumber: '10', availability: 'SOLD' },
      ]);
    prisma.plotBooking.findMany.mockResolvedValue([
      { id: 501, plotSiteId: 30, bookingNumber: 'BOOK-501', status: 'TRANSACTION_COMPLETED', invoiceId: 701 },
    ]);

    const response = await request(makeApp())
      .post('/api/pickup-plot-inventory/customer-pickups/61/plots')
      .send({ plotSiteIds: [33], replacePlotSiteId: 30 });

    expect(response.status).toBe(409);
    expect(response.body).toEqual({
      error: 'A purchased plot cannot be changed. View the selected plot instead.',
      code: 'PURCHASED_PLOT_IMMUTABLE',
    });
    expect(prisma.plotBooking.update).not.toHaveBeenCalled();
  });

  test('allows choosing any plot name before selecting its different plot numbers', async () => {
    prisma.contact.findFirst.mockResolvedValue({ id: 61 });
    prisma.customerPickup.findUnique.mockResolvedValue({ id: 91 });
    prisma.plotSite.findMany
      .mockResolvedValueOnce([
        { id: 41, name: 'Lake View', plotNumber: '8', price: 3900000, availability: 'AVAILABLE' },
        { id: 42, name: 'Lake View', plotNumber: '9', price: 4100000, availability: 'AVAILABLE' },
      ])
      .mockResolvedValueOnce([
        { id: 30, name: 'North Avenue', plotNumber: '24' },
      ]);
    prisma.plotBooking.findMany.mockResolvedValue([
      { id: 501, plotSiteId: 30, bookingNumber: 'BOOK-501', status: 'PLOT_RESERVED' },
    ]);

    const response = await request(makeApp())
      .post('/api/pickup-plot-inventory/customer-pickups/61/plots')
      .send({ plotSiteIds: [41, 42] });

    expect(response.status, JSON.stringify(response.body)).toBe(201);
    expect(response.body).toMatchObject({ bookingsCreated: 2, assignedPlotIds: [30, 41, 42] });
    expect(prisma.plotBooking.create).toHaveBeenCalledTimes(2);
  });

  test('does not assign a plot that is unavailable to this customer', async () => {
    prisma.contact.findFirst.mockResolvedValue({ id: 61 });
    prisma.customerPickup.findUnique.mockResolvedValue({ id: 91 });
    prisma.plotSite.findMany.mockResolvedValue([
      { id: 33, name: 'Garden Road', plotNumber: '9', price: 3900000, availability: 'SOLD' },
    ]);

    const response = await request(makeApp())
      .post('/api/pickup-plot-inventory/customer-pickups/61/plots')
      .send({ plotSiteIds: [33] });

    expect(response.status).toBe(409);
    expect(response.body.code).toBe('PLOT_NOT_AVAILABLE');
    expect(prisma.plotBooking.create).not.toHaveBeenCalled();
  });

  test('requires multiple selections to use one plot name and different plot numbers', async () => {
    prisma.contact.findFirst.mockResolvedValue({ id: 61 });
    prisma.customerPickup.findUnique.mockResolvedValue({ id: 91 });
    prisma.plotSite.findMany.mockResolvedValue([
      { id: 31, name: 'North Avenue', plotNumber: '25', price: 4200000, availability: 'AVAILABLE' },
      { id: 32, name: 'Lake View', plotNumber: '25', price: 5100000, availability: 'AVAILABLE' },
    ]);

    const response = await request(makeApp())
      .post('/api/pickup-plot-inventory/customer-pickups/61/plots')
      .send({ plotSiteIds: [31, 32] });

    expect(response.status).toBe(400);
    expect(response.body.code).toBe('PLOT_NAME_MISMATCH');
    expect(prisma.plotBooking.create).not.toHaveBeenCalled();
  });

  test('rejects duplicate plot numbers under the same plot name', async () => {
    prisma.contact.findFirst.mockResolvedValue({ id: 61 });
    prisma.customerPickup.findUnique.mockResolvedValue({ id: 91 });
    prisma.plotSite.findMany.mockResolvedValue([
      { id: 31, name: 'North Avenue', plotNumber: '25', price: 4200000, availability: 'AVAILABLE' },
      { id: 34, name: 'North Avenue', plotNumber: '25', price: 4100000, availability: 'AVAILABLE' },
    ]);

    const response = await request(makeApp())
      .post('/api/pickup-plot-inventory/customer-pickups/61/plots')
      .send({ plotSiteIds: [31, 34] });

    expect(response.status).toBe(400);
    expect(response.body.code).toBe('DUPLICATE_PLOT_NUMBER');
    expect(prisma.plotBooking.create).not.toHaveBeenCalled();
  });

  test('records a dated initial UPI payment and updates the booking balance', async () => {
    prisma.contact.findFirst.mockResolvedValue({ id: 61, name: 'Priya Shah' });
    prisma.plotSite.findFirst.mockResolvedValue({ id: 30, name: 'North Avenue', plotNumber: '24' });
    prisma.plotBooking.findFirst.mockResolvedValue({
      id: 501, bookingNumber: 'BOOK-501', tenantId: 7, contactId: 61,
      plotSiteId: 30, totalAmount: 4500000, amountPaid: 0, balance: 4500000,
    });
    prisma.invoice.create.mockImplementation(async ({ data }) => ({ id: 801, ...data }));
    prisma.payment.create.mockResolvedValue({
      id: 701, amount: 500000, currency: 'INR', gateway: 'upi', gatewayId: 'UTR-NEW',
      status: 'SUCCESS', paidAt: new Date('2026-10-15T06:30:00.000Z'), createdAt: new Date(),
    });

    const response = await request(makeApp())
      .post('/api/pickup-plot-inventory/customer-pickups/61/initial-payment')
      .send({ amount: 500000, method: 'upi', paidAt: '2026-10-15T06:30:00.000Z', transactionRef: 'UTR-NEW' });

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(prisma.payment.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        contactId: 61, amount: 500000, currency: 'INR', gateway: 'upi',
        plotPaymentReference: 'UTR-NEW', status: 'SUCCESS', tenantId: 7,
      }),
    });
    expect(prisma.plotBooking.update).toHaveBeenCalledWith({
      where: { id: 501 },
      data: { amountPaid: 500000, balance: 4000000, paymentStatus: 'PARTIAL' },
    });
    expect(prisma.invoice.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        amount: 4500000, contactId: 61, status: 'UNPAID', amountPaid: 500000,
        balance: 4000000, currency: 'INR', tenantId: 7,
      }),
    });
    expect(prisma.plotBooking.update).toHaveBeenCalledWith({
      where: { id: 501 },
      data: { invoiceId: 801 },
    });
    expect(prisma.payment.update).toHaveBeenCalledWith({
      where: { id: 701 },
      data: { invoiceId: 801 },
    });
    expect(response.body).toMatchObject({
      mode: 'recorded', booking: { id: 501, amountPaid: 500000, balance: 4000000 },
    });
  });

  test('records cash at the submitted time without storing a payment reference', async () => {
    prisma.contact.findFirst.mockResolvedValue({ id: 61, name: 'Priya Shah' });
    prisma.plotSite.findFirst.mockResolvedValue({ id: 30, name: 'North Avenue', plotNumber: '24' });
    prisma.plotBooking.findFirst.mockResolvedValue({
      id: 501, bookingNumber: 'BOOK-501', tenantId: 7, contactId: 61,
      plotSiteId: 30, totalAmount: 4500000, amountPaid: 0, balance: 4500000,
    });
    prisma.invoice.create.mockImplementation(async ({ data }) => ({ id: 801, ...data }));
    prisma.payment.create.mockImplementation(async ({ data }) => ({ id: 701, createdAt: new Date(), ...data }));

    const response = await request(makeApp())
      .post('/api/pickup-plot-inventory/customer-pickups/61/initial-payment')
      .send({ amount: 500000, method: 'cash', paidAt: '2026-10-15T06:30:00.000Z' });

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const createdPayment = prisma.payment.create.mock.calls[0][0].data;
    expect(createdPayment.gateway).toBe('cash');
    expect(createdPayment.gatewayId).toBeNull();
    expect(createdPayment.plotPaymentReference).toBeNull();
    expect(createdPayment.paidAt).toEqual(new Date('2026-10-15T06:30:00.000Z'));
    expect(prisma.payment.findFirst).not.toHaveBeenCalled();
  });

  test('creates an earned commission from a successful manual plot payment', async () => {
    prisma.contact.findFirst.mockResolvedValue({ id: 61, name: 'Priya Shah' });
    prisma.plotBooking.findFirst.mockResolvedValue({
      id: 501, bookingNumber: 'BOOK-501', tenantId: 7, contactId: 61,
      plotSiteId: 30, plotBrokerId: 51, totalAmount: 4500000, amountPaid: 0, balance: 4500000,
    });
    prisma.plotBroker.findFirst.mockResolvedValue({ id: 51, commissionPercent: 10 });
    prisma.payment.create.mockImplementation(async ({ data }) => ({ id: 701, ...data }));
    prisma.plotCommission.create.mockResolvedValue({ id: 801 });

    const response = await request(makeApp())
      .post('/api/pickup-plot-inventory/customer-pickups/61/initial-payment')
      .send({ amount: 20000, method: 'upi', transactionRef: 'pay-commission-test' });

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(prisma.plotCommission.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        tenantId: 7,
        plotBookingId: 501,
        paymentId: 701,
        plotBrokerId: 51,
        eligibleAmount: 4500000,
        commissionPercent: 10,
        commissionAmount: 450000,
        status: 'EARNED',
      }),
    }));
  });

  test('creates and persists an ordered monthly installment schedule', async () => {
    prisma.plotBooking.findFirst.mockResolvedValue({
      id: 501, tenantId: 7, contactId: 61, status: 'PARTIAL', balance: 120000,
    });
    prisma.plotInstallment.findMany.mockResolvedValue([]);
    let id = 900;
    prisma.plotInstallment.create.mockImplementation(async ({ data }) => ({ id: ++id, ...data }));

    const response = await request(makeApp())
      .post('/api/pickup-plot-inventory/customer-pickups/61/installments')
      .send({
        plotBookingId: 501,
        frequency: 'MONTHLY',
        paymentCount: 3,
        firstPaymentDate: '2026-11-15',
        amount: 40000,
      });

    expect(response.status, JSON.stringify(response.body)).toBe(201);
    expect(response.body.installments).toHaveLength(3);
    expect(response.body.installments.map((row) => row.sequenceNumber)).toEqual([1, 2, 3]);
    expect(response.body.installments.map((row) => row.dueDate.slice(0, 7))).toEqual(['2026-11', '2026-12', '2027-01']);
    expect(response.body.installments.map((row) => row.dueDate.slice(8, 10))).toEqual(['15', '15', '15']);
    expect(prisma.plotInstallment.create).toHaveBeenCalledTimes(3);
  });

  test.each([
    ['QUARTERLY', ['2026-11', '2027-02', '2027-05']],
    ['HALF_YEARLY', ['2026-11', '2027-05', '2027-11']],
    ['YEARLY', ['2026-11', '2027-11', '2028-11']],
  ])('creates a %s installment schedule from the exact first payment date', async (frequency, expectedMonths) => {
    prisma.plotBooking.findFirst.mockResolvedValue({
      id: 501, tenantId: 7, contactId: 61, status: 'PARTIAL', balance: 120000,
    });
    prisma.plotInstallment.findMany.mockResolvedValue([]);
    prisma.plotInstallment.create.mockImplementation(async ({ data }) => ({ id: data.sequenceNumber, ...data }));

    const response = await request(makeApp())
      .post('/api/pickup-plot-inventory/customer-pickups/61/installments')
      .send({ plotBookingId: 501, frequency, paymentCount: 3, firstPaymentDate: '2026-11-15', amount: 40000 });

    expect(response.status, JSON.stringify(response.body)).toBe(201);
    expect(response.body.installments.map((row) => row.dueDate.slice(0, 7))).toEqual(expectedMonths);
  });

  test('replaces an unpaid installment plan with the edited schedule', async () => {
    prisma.plotBooking.findFirst.mockResolvedValue({
      id: 501, tenantId: 7, contactId: 61, status: 'PARTIAL', balance: 120000,
    });
    prisma.plotInstallment.findMany.mockResolvedValue([
      { id: 901, status: 'PLANNED', paymentId: null, sequenceNumber: 1 },
      { id: 902, status: 'PLANNED', paymentId: null, sequenceNumber: 2 },
    ]);
    prisma.plotInstallment.deleteMany.mockResolvedValue({ count: 2 });
    prisma.plotInstallment.create.mockImplementation(async ({ data }) => ({ id: 910 + data.sequenceNumber, ...data }));

    const response = await request(makeApp())
      .put('/api/pickup-plot-inventory/customer-pickups/61/installments')
      .send({ plotBookingId: 501, frequency: 'QUARTERLY', paymentCount: 3, firstPaymentDate: '2026-12-20', amount: 40000 });

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(prisma.plotInstallment.deleteMany).toHaveBeenCalledWith({
      where: { tenantId: 7, plotBookingId: 501, id: { in: [901, 902] }, status: 'PLANNED', paymentId: null },
    });
    expect(response.body.installments.map((row) => row.sequenceNumber)).toEqual([1, 2, 3]);
    expect(response.body.installments.map((row) => row.dueDate.slice(0, 10))).toEqual(['2026-12-20', '2027-03-20', '2027-06-20']);
  });

  test('locks installment-plan editing after any installment payment starts', async () => {
    prisma.plotBooking.findFirst.mockResolvedValue({
      id: 501, tenantId: 7, contactId: 61, status: 'PARTIAL', balance: 80000,
    });
    prisma.plotInstallment.findMany.mockResolvedValue([
      { id: 901, status: 'PAID', paymentId: 701, sequenceNumber: 1 },
      { id: 902, status: 'PLANNED', paymentId: null, sequenceNumber: 2 },
    ]);

    const response = await request(makeApp())
      .put('/api/pickup-plot-inventory/customer-pickups/61/installments')
      .send({ plotBookingId: 501, frequency: 'MONTHLY', paymentCount: 2, firstPaymentDate: '2026-12-20', amount: 40000 });

    expect(response.status).toBe(409);
    expect(response.body.code).toBe('INSTALLMENT_PLAN_LOCKED');
    expect(prisma.plotInstallment.deleteMany).not.toHaveBeenCalled();
  });

  test('does not replace a plan when a payment starts during the edit', async () => {
    prisma.plotBooking.findFirst.mockResolvedValue({
      id: 501, tenantId: 7, contactId: 61, status: 'PARTIAL', balance: 80000,
    });
    prisma.plotInstallment.findMany.mockResolvedValue([
      { id: 901, status: 'PLANNED', paymentId: null, sequenceNumber: 1 },
      { id: 902, status: 'PLANNED', paymentId: null, sequenceNumber: 2 },
    ]);
    prisma.plotInstallment.deleteMany.mockResolvedValue({ count: 1 });

    const response = await request(makeApp())
      .put('/api/pickup-plot-inventory/customer-pickups/61/installments')
      .send({ plotBookingId: 501, frequency: 'MONTHLY', paymentCount: 2, firstPaymentDate: '2026-12-20', amount: 40000 });

    expect(response.status).toBe(409);
    expect(response.body.code).toBe('INSTALLMENT_PLAN_LOCKED');
    expect(prisma.plotInstallment.create).not.toHaveBeenCalled();
  });

  test.each(['balance', 'plan', 'cancelled'])('rejects concurrent %s changes under the booking lock', async (change) => {
    const booking = { id: 501, tenantId: 7, contactId: 61, status: 'PARTIAL', balance: 80000 };
    prisma.plotBooking.findFirst.mockResolvedValueOnce(booking).mockResolvedValueOnce(
      change === 'cancelled' ? null : { ...booking, balance: change === 'balance' ? 10000 : 80000 },
    );
    const rows = [{ id: 901, status: 'PLANNED', paymentId: null }];
    prisma.plotInstallment.findMany.mockResolvedValueOnce(rows).mockResolvedValueOnce(
      change === 'plan' ? [{ ...rows[0], id: 902 }] : rows,
    );
    const response = await request(makeApp())
      .put('/api/pickup-plot-inventory/customer-pickups/61/installments')
      .send({ plotBookingId: 501, frequency: 'MONTHLY', paymentCount: 2, firstPaymentDate: '2026-12-20', amount: 40000 });
    expect(response.status).toBe(change === 'balance' ? 400 : change === 'cancelled' ? 404 : 409);
    expect(prisma.$queryRaw.mock.calls.some(([parts]) => parts.join('').includes('FOR UPDATE'))).toBe(true);
    expect(prisma.plotInstallment.deleteMany).not.toHaveBeenCalled();
  });

  test('keeps installment-plan creation exclusive to Generic CRM tenants', async () => {
    prisma.tenant.findUnique.mockResolvedValueOnce({ vertical: 'wellness' });

    const response = await request(makeApp())
      .post('/api/pickup-plot-inventory/customer-pickups/61/installments')
      .send({ plotBookingId: 501, frequency: 'MONTHLY', paymentCount: 2, firstPaymentDate: '2026-11-15', amount: 40000 });

    expect(response.status).toBe(404);
    expect(response.body.code).toBe('GENERIC_CRM_ONLY');
    expect(prisma.plotInstallment.create).not.toHaveBeenCalled();
  });

  test('lets an admin change the one-time commission percentage on the total deal', async () => {
    prisma.plotCommission.findFirst.mockResolvedValue({
      id: 801, tenantId: 7, plotBookingId: 501, paymentId: 701, plotBrokerId: 51,
      contactId: 61, commissionPercent: 10, eligibleAmount: 4500000,
      commissionAmount: 450000, status: 'EARNED',
    });
    prisma.plotCommission.update.mockImplementation(async ({ data }) => ({
      id: 801, eligibleAmount: 4500000, status: 'EARNED', ...data,
    }));

    const response = await request(makeApp())
      .patch('/api/pickup-plot-inventory/commissions/801/rate')
      .send({ commissionPercent: 5 });

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body).toMatchObject({ commissionPercent: 5, commissionAmount: 225000 });
    expect(prisma.plotCommission.update).toHaveBeenCalledWith({
      where: { id: 801 },
      data: { commissionPercent: 5, commissionAmount: 225000 },
    });
  });

  test.each(['APPROVED', 'PAID'])('rejects unfunded commission transition to %s', async status => {
    prisma.plotCommission.findFirst.mockResolvedValue({ id: 801, plotBookingId: 501, status: status === 'PAID' ? 'APPROVED' : 'EARNED', commissionAmount: 450000 });
    prisma.$queryRaw.mockResolvedValue([{ amountPaid: 20000 }]);
    const response = await request(makeApp()).patch('/api/pickup-plot-inventory/commissions/801/status').send({ status });
    expect(response.status).toBe(409);
    expect(response.body.code).toBe('COMMISSION_NOT_FUNDED');
    expect(prisma.plotCommission.update).not.toHaveBeenCalled();
  });

  test('rechecks installment status inside the booking transaction', async () => {
    prisma.contact.findFirst.mockResolvedValue({ id: 61 });
    prisma.plotBooking.findFirst.mockResolvedValue({ id: 501, totalAmount: 1000, balance: 1000, amountPaid: 0 });
    prisma.plotInstallment.findFirst.mockResolvedValueOnce({ id: 901, status: 'PLANNED', amount: 100 }).mockResolvedValueOnce(null);
    const response = await request(makeApp()).post('/api/pickup-plot-inventory/customer-pickups/61/initial-payment').send({ amount: 100, installmentId: 901, method: 'cash', transactionRef: 'installment-race' });
    expect(response.status).toBe(409);
    expect(response.body.code).toBe('INSTALLMENT_NOT_PAYABLE');
    expect(prisma.plotInstallment.update).not.toHaveBeenCalled();
  });

  test('lets an admin approve an earned commission', async () => {
    prisma.$queryRaw.mockResolvedValue([{ amountPaid: 20000 }]);
    prisma.plotCommission.findFirst.mockResolvedValue({
      id: 801, tenantId: 7, plotBookingId: 501, paymentId: 701, plotBrokerId: 51,
      contactId: 61, commissionPercent: 10, eligibleAmount: 20000,
      commissionAmount: 2000, status: 'EARNED',
    });
    prisma.plotCommission.update.mockImplementation(async ({ data }) => ({
      id: 801, commissionPercent: 10, eligibleAmount: 20000, commissionAmount: 2000, ...data,
    }));

    const response = await request(makeApp())
      .patch('/api/pickup-plot-inventory/commissions/801/status')
      .send({ status: 'APPROVED' });

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body).toMatchObject({ id: 801, status: 'APPROVED', commissionAmount: 2000 });
    expect(prisma.plotCommission.update).toHaveBeenCalledWith({
      where: { id: 801 },
      data: expect.objectContaining({ status: 'APPROVED', approvedByUserId: 3 }),
    });
    expect(prisma.plotWorkflowEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        tenantId: 7, plotBookingId: 501, contactId: 61,
        stage: 'COMMISSION', eventType: 'APPROVED', toStatus: 'APPROVED',
      }),
    });
  });

  test('lets an admin set the one-time commission deduction amount', async () => {
    prisma.plotCommission.findFirst.mockResolvedValue({
      id: 801, tenantId: 7, plotBookingId: 501, paymentId: 701, plotBrokerId: 51,
      contactId: 61, commissionPercent: 10, eligibleAmount: 20000,
      commissionAmount: 2000, status: 'EARNED',
    });
    prisma.plotCommission.update.mockImplementation(async ({ data }) => ({
      id: 801, eligibleAmount: 20000, status: 'EARNED', ...data,
    }));

    const response = await request(makeApp())
      .patch('/api/pickup-plot-inventory/commissions/801/amount')
      .send({ commissionAmount: 1500 });

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body).toMatchObject({
      commissionAmount: 1500, commissionPercent: 7.5, netPaymentAmount: 18500,
    });
    expect(prisma.plotCommission.update).toHaveBeenCalledWith({
      where: { id: 801 },
      data: { commissionAmount: 1500, commissionPercent: 7.5 },
    });
  });

  test('serializes concurrent payments and rechecks the balance inside the booking lock', async () => {
    const booking = { id: 501, tenantId: 7, contactId: 61, totalAmount: 100, amountPaid: 0, balance: 100 };
    prisma.contact.findFirst.mockResolvedValue({ id: 61, name: 'Customer' });
    prisma.plotBooking.findFirst.mockImplementation(async () => ({ ...booking }));
    prisma.plotBooking.update.mockImplementation(async ({ data }) => Object.assign(booking, data));
    prisma.payment.create.mockImplementation(async ({ data }) => ({ id: 701, ...data }));
    let previous = Promise.resolve();
    prisma.$transaction.mockImplementation(async callback => {
      const wait = previous;
      let release;
      previous = new Promise(resolve => { release = resolve; });
      await wait;
      try { return await callback(prisma); } finally { release(); }
    });
    const responses = await Promise.all(['A', 'B'].map(transactionRef => request(makeApp())
      .post('/api/pickup-plot-inventory/customer-pickups/61/initial-payment')
      .send({ amount: 60, method: 'cash', transactionRef })));
    expect(responses.map(res => res.status).sort()).toEqual([200, 400]);
    expect(responses.find(res => res.status === 400).body.code).toBe('PAYMENT_EXCEEDS_BALANCE');
    expect(prisma.payment.create).toHaveBeenCalledTimes(1);
    expect(booking).toMatchObject({ amountPaid: 60, balance: 40 });
    const lock = prisma.$queryRaw.mock.calls.find(([parts]) => parts.join('').includes('FOR UPDATE'));
    expect(lock.slice(1)).toEqual([501, 7]);
  });

  test('includes gateway payments committed before booking reconciliation when checking the cash balance', async () => {
    prisma.contact.findFirst.mockResolvedValue({ id: 61, name: 'Customer' });
    prisma.plotBooking.findFirst.mockResolvedValue({ id: 501, totalAmount: 100, amountPaid: 0, balance: 100 });
    prisma.$queryRaw.mockImplementation(async parts => parts.join('').includes('SUM(amount)') ? [{ amountPaid: 60 }] : [{ id: 501 }]);
    const response = await request(makeApp())
      .post('/api/pickup-plot-inventory/customer-pickups/61/initial-payment')
      .send({ amount: 60, method: 'cash', transactionRef: 'cash-after-gateway' });
    expect(response.status).toBe(400);
    expect(response.body.code).toBe('PAYMENT_EXCEEDS_BALANCE');
    expect(prisma.payment.create).not.toHaveBeenCalled();
  });

  test('generates an online initial-payment link for UPI, card, and net banking', async () => {
    prisma.contact.findFirst.mockResolvedValue({ id: 61, name: 'Priya Shah', email: 'priya@example.com', phone: '9000022222' });
    prisma.plotBooking.findFirst.mockResolvedValue({
      id: 501, bookingNumber: 'BOOK-501', tenantId: 7, contactId: 61,
      plotSiteId: 30, totalAmount: 4500000, amountPaid: 0, balance: 4500000,
    });
    prisma.tenant.findUnique.mockResolvedValue({ name: 'NovaCrest Technologies', vertical: 'generic' });

    const response = await request(makeApp())
      .post('/api/pickup-plot-inventory/customer-pickups/61/initial-payment')
      .send({ amount: 500000, method: 'payment_link', plotBookingId: 501 });

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(paymentLink.createInvoicePaymentLink).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: 7,
      invoice: { id: 501, invoiceNum: 'BOOK-501', amount: 500000 },
      contactId: 61,
      currency: 'INR',
      gatewayPref: 'razorpay',
      travelContext: { kind: 'plot-booking-payment', plotBookingId: 501 },
    }));
    expect(prisma.plotBooking.findFirst).toHaveBeenCalledWith({
      where: {
        tenantId: 7,
        contactId: 61,
        id: 501,
        status: { notIn: ['CANCELLED', 'PLOT_ASSIGNED'] },
      },
      orderBy: { updatedAt: 'desc' },
    });
    expect(response.body).toMatchObject({
      mode: 'payment_link', url: 'https://pay.example.test/plot-booking', gateway: 'razorpay',
      payment: { id: 801, amount: 500000, status: 'PENDING' },
    });
  });

  test('tags a Razorpay installment link so the paid webhook closes the scheduled installment', async () => {
    prisma.contact.findFirst.mockResolvedValue({ id: 61, name: 'Priya Shah', email: 'priya@example.com', phone: '9000022222' });
    prisma.plotBooking.findFirst.mockResolvedValue({
      id: 501, bookingNumber: 'BOOK-501', tenantId: 7, contactId: 61,
      plotSiteId: 30, totalAmount: 4500000, amountPaid: 500000, balance: 4000000,
    });
    prisma.plotInstallment.findFirst.mockReset().mockResolvedValue({
      id: 901, tenantId: 7, plotBookingId: 501, contactId: 61,
      sequenceNumber: 2, amount: 250000, status: 'PLANNED',
    });
    prisma.tenant.findUnique.mockResolvedValue({ name: 'NovaCrest Technologies', vertical: 'generic' });

    const response = await request(makeApp())
      .post('/api/pickup-plot-inventory/customer-pickups/61/initial-payment')
      .send({ amount: 250000, method: 'payment_link', plotBookingId: 501, installmentId: 901 });

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(paymentLink.createInvoicePaymentLink).toHaveBeenCalledWith(expect.objectContaining({
      gatewayPref: 'razorpay',
      travelContext: { kind: 'plot-booking-payment', plotBookingId: 501, installmentId: 901 },
      description: 'Installment 2 for plot booking BOOK-501',
    }));
    expect(prisma.plotInstallment.update).toHaveBeenCalledWith({
      where: { id: 901 },
      data: { status: 'PAYMENT_INITIATED', paymentId: 801 },
    });
  });

  test.each(['LINK_CREATED', 'PAYMENT_INITIATED', 'PROCESSING', 'FAILED', 'LINK_CREATING'])('blocks cash and new links for an active or uncertain installment %s', async (status) => {
    prisma.contact.findFirst.mockResolvedValue({ id: 61, name: 'Priya Shah' });
    prisma.plotBooking.findFirst.mockResolvedValue({ id: 501, tenantId: 7, contactId: 61, balance: 1000 });
    prisma.plotInstallment.findFirst.mockReset().mockResolvedValue({ id: 901, tenantId: 7, plotBookingId: 501, contactId: 61, amount: 100, status, paymentId: status === 'LINK_CREATING' ? null : 801 });
    for (const method of ['cash', 'payment_link']) {
      const response = await request(makeApp()).post('/api/pickup-plot-inventory/customer-pickups/61/initial-payment')
        .send({ amount: 100, plotBookingId: 501, installmentId: 901, method });
      expect(response.status).toBe(409);
      expect(response.body.code).toBe('INSTALLMENT_NOT_PAYABLE');
    }
    expect(paymentLink.createInvoicePaymentLink).not.toHaveBeenCalled();
  });

  test('does not create a link when another request claimed the installment', async () => {
    prisma.contact.findFirst.mockResolvedValue({ id: 61, name: 'Priya Shah' });
    prisma.plotBooking.findFirst.mockResolvedValue({ id: 501, tenantId: 7, contactId: 61, balance: 1000 });
    prisma.plotInstallment.findFirst.mockReset().mockResolvedValue({ id: 901, tenantId: 7, plotBookingId: 501, contactId: 61, amount: 100, status: 'PLANNED', paymentId: null });
    prisma.plotInstallment.updateMany.mockResolvedValueOnce({ count: 0 });
    const response = await request(makeApp()).post('/api/pickup-plot-inventory/customer-pickups/61/initial-payment')
      .send({ amount: 100, plotBookingId: 501, installmentId: 901, method: 'payment_link' });
    expect(response.status).toBe(409);
    expect(paymentLink.createInvoicePaymentLink).not.toHaveBeenCalled();
  });

  test('returns a gateway error instead of a false payment success when Razorpay supplies no link URL', async () => {
    prisma.contact.findFirst.mockResolvedValue({ id: 61, name: 'Priya Shah' });
    prisma.plotBooking.findFirst.mockResolvedValue({
      id: 501, bookingNumber: 'BOOK-501', tenantId: 7, contactId: 61,
      plotSiteId: 30, totalAmount: 4500000, amountPaid: 0, balance: 4500000,
    });
    prisma.tenant.findUnique.mockResolvedValue({ name: 'NovaCrest Technologies', vertical: 'generic' });
    paymentLink.createInvoicePaymentLink.mockResolvedValueOnce({ gateway: 'razorpay', paymentId: 801 });

    const response = await request(makeApp())
      .post('/api/pickup-plot-inventory/customer-pickups/61/initial-payment')
      .send({ amount: 500000, method: 'payment_link', plotBookingId: 501 });

    expect(response.status).toBe(502);
    expect(response.body).toMatchObject({ code: 'PAYMENT_LINK_URL_MISSING' });
    expect(prisma.plotBooking.update).not.toHaveBeenCalled();
  });

  test('preserves Razorpay amount-limit validation instead of reporting a gateway outage', async () => {
    prisma.contact.findFirst.mockResolvedValue({ id: 61, name: 'Priya Shah' });
    prisma.plotBooking.findFirst.mockResolvedValue({
      id: 501, bookingNumber: 'BOOK-501', tenantId: 7, contactId: 61,
      plotSiteId: 30, totalAmount: 20000000, amountPaid: 0, balance: 20000000,
    });
    prisma.tenant.findUnique.mockResolvedValue({ name: 'NovaCrest Technologies', vertical: 'generic' });
    paymentLink.createInvoicePaymentLink.mockResolvedValueOnce({
      error: "This amount is above the connected Razorpay account's per-transaction limit. Enter a smaller payment amount or ask the administrator to raise the transaction limit in Razorpay.",
      code: 'PAYMENT_AMOUNT_LIMIT_EXCEEDED',
      status: 400,
      gateway: 'razorpay',
    });

    const response = await request(makeApp())
      .post('/api/pickup-plot-inventory/customer-pickups/61/initial-payment')
      .send({ amount: 2000000, method: 'payment_link', plotBookingId: 501 });

    expect(response.status).toBe(400);
    expect(response.body.code).toBe('PAYMENT_AMOUNT_LIMIT_EXCEEDED');
    expect(response.body.error).toMatch(/smaller payment amount/i);
    expect(prisma.payment.create).not.toHaveBeenCalled();
  });

  test('requires a selected plot booking before generating an initial payment', async () => {
    prisma.contact.findFirst.mockResolvedValue({ id: 61, name: 'Priya Shah' });
    prisma.plotBooking.findFirst.mockResolvedValue(null);

    const response = await request(makeApp())
      .post('/api/pickup-plot-inventory/customer-pickups/61/initial-payment')
      .send({ amount: 500000, method: 'upi', transactionRef: 'UTR-NEW' });

    expect(response.status).toBe(409);
    expect(response.body.code).toBe('PLOT_BOOKING_REQUIRED');
    expect(prisma.plotBooking.findFirst).toHaveBeenCalledWith({
      where: { tenantId: 7, contactId: 61, status: { notIn: ['CANCELLED', 'PLOT_ASSIGNED'] } },
      orderBy: { updatedAt: 'desc' },
    });
    expect(prisma.payment.create).not.toHaveBeenCalled();
  });

  test('keeps an admin-assigned plot available until the customer selects it', async () => {
    prisma.pickupLocation.findMany.mockResolvedValue([{
      id: 4, name: 'Main Gate', address: '42 Lake View Road, Bengaluru',
      googleMapsLink: 'https://maps.google.com/?q=42+Lake+View+Road',
    }]);
    prisma.customerPickup.findMany.mockResolvedValue([{
      id: 91, tenantId: 7, contactId: 61, pickupAddress: '42 Lake View Road, Bengaluru',
      contact: { id: 61, name: 'Priya Shah' },
    }]);
    prisma.plotSite.findMany.mockResolvedValue([{
      id: 31, name: 'North Avenue', plotNumber: '25', availability: 'AVAILABLE', isActive: true,
    }]);
    prisma.plotBooking.findMany.mockResolvedValue([{
      id: 502, bookingNumber: 'BOOK-502', contactId: 61, plotSiteId: 31,
      status: 'PLOT_ASSIGNED', paymentStatus: 'UNPAID', totalAmount: 4200000,
      amountPaid: 0, balance: 4200000,
    }]);

    const response = await request(makeApp()).get('/api/pickup-plot-inventory/customer-pickups');

    expect(response.status).toBe(200);
    expect(prisma.customerPickup.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { tenantId: 7, contact: { deletedAt: null } },
    }));
    expect(response.body.customers[0]).toMatchObject({
      assignedPlot: { id: 31, plotNumber: '25', availability: 'AVAILABLE' },
      assignedPlots: [{ id: 31, plotNumber: '25', availability: 'AVAILABLE' }],
      selectedPlot: null,
      booking: null,
      payments: [],
    });
    expect(response.body.plots).toEqual([
      expect.objectContaining({ id: 31, availability: 'AVAILABLE' }),
    ]);
    expect(response.body.pickupLocations).toEqual([
      expect.objectContaining({ id: 4, name: 'Main Gate', address: '42 Lake View Road, Bengaluru' }),
    ]);
    expect(prisma.pickupLocation.findMany).toHaveBeenCalledWith({
      where: { tenantId: 7, isActive: true },
      orderBy: { name: 'asc' },
      select: { id: true, name: true, address: true, googleMapsLink: true },
    });
  });

  test('returns effective installment statuses, active links, overdue rows, and paid receipts', async () => {
    prisma.customerPickup.findMany.mockResolvedValue([{
      id: 91, tenantId: 7, contactId: 61, pickupAddress: 'Bengaluru',
      contact: { id: 61, name: 'Priya Shah' },
    }]);
    prisma.plotSite.findMany.mockResolvedValue([{
      id: 31, name: 'North Avenue', plotNumber: '25', availability: 'RESERVED', isActive: true,
    }]);
    prisma.plotBooking.findMany.mockResolvedValue([{
      id: 502, bookingNumber: 'BOOK-502', contactId: 61, plotSiteId: 31,
      status: 'PARTIAL', paymentStatus: 'PARTIAL', totalAmount: 200000,
      amountPaid: 50000, balance: 150000,
    }]);
    prisma.payment.findMany.mockResolvedValue([
      { id: 800, tenantId: 7, contactId: 61, amount: 25000, status: 'PENDING', gateway: 'razorpay', gatewayId: 'plink_initial', metadata: JSON.stringify({ kind: 'plot-booking-payment', plotBookingId: 502, url: 'https://rzp.io/i/initial', plinkId: 'plink_initial' }) },
      { id: 801, tenantId: 7, contactId: 61, amount: 50000, status: 'PROCESSING', gateway: 'razorpay', gatewayId: 'plink_active', metadata: JSON.stringify({ kind: 'plot-booking-payment', plotBookingId: 502, installmentId: 901, url: 'https://rzp.io/i/active', plinkId: 'plink_active' }) },
      { id: 802, tenantId: 7, contactId: 61, amount: 50000, status: 'SUCCESS', gateway: 'razorpay', gatewayId: 'pay_paid', metadata: JSON.stringify({ kind: 'plot-booking-payment', plotBookingId: 502, installmentId: 902, plinkId: 'plink_paid' }) },
    ]);
    prisma.plotInstallment.findMany.mockResolvedValue([
      { id: 901, tenantId: 7, plotBookingId: 502, contactId: 61, sequenceNumber: 1, frequency: 'MONTHLY', dueDate: new Date('2026-11-15T12:00:00.000Z'), amount: 50000, status: 'PAYMENT_INITIATED', paymentId: 801 },
      { id: 902, tenantId: 7, plotBookingId: 502, contactId: 61, sequenceNumber: 2, frequency: 'MONTHLY', dueDate: new Date('2026-12-15T12:00:00.000Z'), amount: 50000, status: 'PAID', paymentId: 802 },
      { id: 903, tenantId: 7, plotBookingId: 502, contactId: 61, sequenceNumber: 3, frequency: 'MONTHLY', dueDate: new Date('2026-09-15T12:00:00.000Z'), amount: 50000, status: 'PLANNED', paymentId: null },
    ]);

    const response = await request(makeApp()).get('/api/pickup-plot-inventory/customer-pickups');

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.customers[0].payments).toContainEqual(expect.objectContaining({
      id: 800,
      paymentLinkUrl: 'https://rzp.io/i/initial',
      receiptUrl: null,
    }));
    expect(response.body.customers[0].installments).toEqual([
      expect.objectContaining({ id: 901, status: 'PROCESSING', paymentLinkUrl: 'https://rzp.io/i/active', receiptUrl: null }),
      expect.objectContaining({ id: 902, status: 'PAID', receiptUrl: '/api/billing/public/receipt?plinkId=plink_paid' }),
      expect.objectContaining({ id: 903, status: 'OVERDUE', paymentLinkUrl: null, receiptUrl: null }),
    ]);
  });

  test('returns plot-only assignments separately from captured pickup customers', async () => {
    prisma.plotSite.findMany.mockResolvedValue([{
      id: 31, name: 'North Avenue', plotNumber: '25', availability: 'RESERVED', isActive: true,
    }]);
    prisma.plotBooking.findMany.mockResolvedValue([{
      id: 502, bookingNumber: 'BOOK-502', contactId: 61, plotSiteId: 31,
      status: 'PLOT_ASSIGNED', paymentStatus: 'UNPAID', totalAmount: 4200000,
      amountPaid: 0, balance: 4200000,
    }]);
    prisma.contact.findMany.mockResolvedValue([{
      id: 61, name: 'Priya Shah', status: 'Lead', interestedPlotArea: 'North Bengaluru',
    }]);

    const response = await request(makeApp()).get('/api/pickup-plot-inventory/customer-pickups');

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.customers).toEqual([]);
    expect(response.body.plotAssignments).toEqual([
      expect.objectContaining({
        contactId: 61,
        contact: expect.objectContaining({ id: 61, name: 'Priya Shah' }),
        assignedPlots: [expect.objectContaining({ id: 31, plotNumber: '25' })],
        customerAssignedPlotIds: [31],
      }),
    ]);
  });

  test('shows a fully paid customer as payment verified instead of payment pending', async () => {
    prisma.customerPickup.findMany.mockResolvedValue([{
      id: 91, tenantId: 7, contactId: 61, pickupAddress: 'Koramangala, Bengaluru',
      contact: { id: 61, name: 'Manoj Kumar' },
    }]);
    prisma.transportPerson.findMany.mockResolvedValue([{
      id: 41, name: 'Sant Kumar', phone: '9000011111', updatedAt: new Date(),
      assignmentPairsJson: '[{"customerId":61,"plotSiteId":30}]',
      assignmentStatusJson: '{"customer-61-plot-30":{"status":"COMPLETED"}}',
    }]);
    prisma.plotBroker.findMany.mockResolvedValue([{
      id: 51, name: 'Sanjeev', phone: '9000022222',
      assignmentPairsJson: '[{"customerId":61,"plotSiteId":30}]',
      workflowStatusJson: '{"customer-61-plot-30":{"status":"PLOT_SELECTED","billingStatus":"PAYMENT_PENDING","plotId":30}}',
    }]);
    prisma.plotSite.findMany.mockResolvedValue([{
      id: 30, name: 'Koramangala', plotNumber: '10', availability: 'RESERVED', isActive: true,
    }]);
    prisma.plotBooking.findMany.mockResolvedValue([{
      id: 501, bookingNumber: 'BOOK-501', contactId: 61, plotSiteId: 30,
      status: 'PAYMENT_RECEIVED', paymentStatus: 'PAID', totalAmount: 200000,
      amountPaid: 200000, balance: 0,
    }]);

    const response = await request(makeApp()).get('/api/pickup-plot-inventory/customer-pickups');

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.customers[0]).toMatchObject({
      currentStage: 'billing',
      currentStatus: 'PAYMENT_VERIFIED',
      workflow: { billing: { status: 'PAYMENT_VERIFIED' } },
      booking: { paymentStatus: 'PAID', balance: 0 },
    });
  });

  test('lists active available plots when imported availability casing differs', async () => {
    prisma.plotSite.findMany.mockResolvedValue([
      { id: 31, name: 'Koramangala', plotNumber: '42', availability: ' available ', isActive: true },
      { id: 32, name: 'Koramangala', plotNumber: '43', availability: 'RESERVED', isActive: true },
      { id: 33, name: 'Koramangala', plotNumber: '44', availability: 'SOLD', isActive: false },
    ]);

    const response = await request(makeApp()).get('/api/pickup-plot-inventory/customer-pickups');

    expect(response.status).toBe(200);
    expect(response.body.plots).toEqual([
      expect.objectContaining({ id: 31, plotNumber: '42' }),
    ]);
    expect(response.body.allPlots).toEqual([
      expect.objectContaining({ id: 31, plotNumber: '42' }),
      expect.objectContaining({ id: 32, plotNumber: '43' }),
    ]);
  });

  test('lists the live transport status for captured customer pickup locations', async () => {
    prisma.customerPickup.findMany.mockResolvedValue([{
      id: 91, tenantId: 7, contactId: 61, pickupAddress: '42 Lake View Road, Bengaluru; is that correct?',
      sourceTranscriptId: '789', updatedAt: new Date('2026-10-06T10:00:00.000Z'),
      contact: { id: 61, name: 'Priya Shah', status: 'Lead' },
    }]);
    prisma.transportPerson.findMany.mockResolvedValue([{
      id: 41, name: 'Sant', phone: '9000011111', customerIdsJson: '[61]',
      assignmentPairsJson: '[{"customerId":61,"plotSiteId":30}]',
      assignmentStatusJson: '{"customer-61":{"status":"PICKED_UP","updatedAt":"2026-10-06T11:00:00.000Z","pickupAt":"2026-10-06T11:00:00.000Z"}}',
      updatedAt: new Date('2026-10-06T10:30:00.000Z'),
    }]);
    prisma.plotSite.findMany.mockResolvedValue([{
      id: 30, name: 'Plot 24', address: 'North Avenue', area: '1200 sq ft', availability: 'RESERVED',
    }]);
    prisma.plotBroker.findMany.mockResolvedValue([{
      id: 51, name: 'Sanjeev', phone: '9000044444', customerIdsJson: '[61]',
      workflowStatusJson: '{"customer-61":{"status":"INTEREST_CONFIRMED","updatedAt":"2026-10-06T12:00:00.000Z","billingStatus":"INVOICE_SENT","billingUpdatedAt":"2026-10-06T13:00:00.000Z"}}',
    }]);
    prisma.plotBooking.findMany.mockResolvedValue([{
      id: 501, bookingNumber: 'BOOK-501', contactId: 61, plotSiteId: 30,
      invoiceId: 601, status: 'PAYMENT_RECEIVED', paymentStatus: 'RECEIVED',
      totalAmount: 4500000, amountPaid: 1000000, balance: 3500000,
    }]);
    prisma.payment.findMany.mockResolvedValue([{
      id: 701, invoiceId: 601, contactId: 61, amount: 1000000, currency: 'INR',
      gateway: 'upi', gatewayId: 'UTR-ONE', status: 'SUCCESS',
      paidAt: new Date('2026-10-07T10:00:00.000Z'),
    }]);

    const response = await request(makeApp()).get('/api/pickup-plot-inventory/customer-pickups');

    expect(response.status).toBe(200);
    expect(response.body.customers[0]).toMatchObject({
      pickupAddress: '42 Lake View Road, Bengaluru', status: 'PICKED_UP',
      transportPerson: { id: 41, name: 'Sant' },
      assignedPlot: { id: 30, name: 'Plot 24', address: 'North Avenue' },
      currentStage: 'transport', currentStatus: 'PICKED_UP',
      workflow: {
        transport: {
          status: 'PICKED_UP', pickupAt: '2026-10-06T11:00:00.000Z', dropOffAt: null,
          assignee: { id: 41, name: 'Sant' },
        },
        broker: { status: 'PLOT_SELECTED', assignee: { id: 51, name: 'Sanjeev' } },
        billing: { status: 'INVOICE_SENT' },
      },
      booking: { id: 501, bookingNumber: 'BOOK-501', balance: 3500000 },
      payments: [{ id: 701, gatewayId: 'UTR-ONE', status: 'SUCCESS' }],
    });
    expect(prisma.plotBooking.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { tenantId: 7 } }));
    expect(prisma.payment.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        tenantId: 7,
        OR: [
          { invoiceId: { not: null } },
          { metadata: { contains: '"kind":"plot-booking-payment"' } },
        ],
      },
    }));
    expect(response.body.summary).toEqual({ total: 1, awaitingAssignment: 0, activeTrips: 1, completed: 0 });
  });

  test('reports the current end-to-end status after transport reaches billing', async () => {
    prisma.customerPickup.findMany.mockResolvedValue([{
      id: 91, tenantId: 7, contactId: 61, pickupAddress: '42 Lake View Road, Bengaluru',
      updatedAt: new Date('2026-10-06T10:00:00.000Z'), contact: { id: 61, name: 'Priya Shah' },
    }]);
    prisma.transportPerson.findMany.mockResolvedValue([{
      id: 41, name: 'Sant', phone: '9000011111', customerIdsJson: '[61]',
      assignmentStatusJson: '{"customer-61":{"status":"COMPLETED","updatedAt":"2026-10-06T11:00:00.000Z"}}',
      updatedAt: new Date('2026-10-06T10:30:00.000Z'),
    }]);
    prisma.plotBroker.findMany.mockResolvedValue([{
      id: 51, name: 'Sanjeev', phone: '9000044444', customerIdsJson: '[61]',
      workflowStatusJson: '{"customer-61":{"status":"INTEREST_CONFIRMED","updatedAt":"2026-10-06T12:00:00.000Z","billingStatus":"PAYMENT_RECEIVED","billingUpdatedAt":"2026-10-06T13:00:00.000Z"}}',
    }]);
    prisma.plotWorkflowEvent.findMany.mockResolvedValue([
      { id: 1, contactId: 61, plotBookingId: 91, plotSiteId: 30, stage: 'TRANSPORT', eventType: 'COMPLETED', label: 'Trip completed', fromStatus: 'ARRIVED_AT_DROP', toStatus: 'COMPLETED', occurredAt: new Date('2026-10-06T11:00:00.000Z') },
      { id: 2, contactId: 61, plotBookingId: 91, plotSiteId: 30, stage: 'PAYMENT', eventType: 'PAYMENT_RECEIVED', label: 'Payment received', fromStatus: 'PAYMENT_PENDING', toStatus: 'PAYMENT_RECEIVED', occurredAt: new Date('2026-10-06T13:00:00.000Z') },
    ]);

    const response = await request(makeApp()).get('/api/pickup-plot-inventory/customer-pickups');

    expect(response.status).toBe(200);
    expect(response.body.customers[0]).toMatchObject({
      status: 'COMPLETED', currentStage: 'billing', currentStatus: 'PAYMENT_RECEIVED',
      currentStatusUpdatedAt: '2026-10-06T13:00:00.000Z',
      workflowHistory: [
        expect.objectContaining({ id: 1, stage: 'TRANSPORT', label: 'Trip completed' }),
        expect.objectContaining({ id: 2, stage: 'PAYMENT', label: 'Payment received' }),
      ],
    });
    expect(response.body.summary).toEqual({ total: 1, awaitingAssignment: 0, activeTrips: 1, completed: 0 });
  });

  test('projects pickup workflow data for the requested Generic Leads page', async () => {
    prisma.contact.findMany.mockResolvedValue([{ id: 61 }]);
    prisma.pickupLocation.findMany.mockResolvedValue([{
      id: 4, name: 'Main Gate', address: '42 Lake View Road, Bengaluru',
      googleMapsLink: 'https://maps.google.com/?q=42+Lake+View+Road',
    }]);
    prisma.customerPickup.findMany.mockResolvedValue([{
      id: 91, tenantId: 7, contactId: 61, pickupAddress: '42 Lake View Road, Bengaluru',
      contact: { id: 61, name: 'Priya Shah', status: 'Lead', interestedPlotArea: 'North Bengaluru' },
    }]);
    prisma.transportPerson.findMany.mockResolvedValue([{
      id: 41, name: 'Sant', customerIdsJson: '[61]', plotSiteIdsJson: '[30]',
      assignmentPairsJson: '[{"customerId":61,"plotSiteId":30}]',
      assignmentStatusJson: '{"customer-61-plot-30":{"status":"COMPLETED"}}',
    }]);
    prisma.plotBooking.findMany.mockResolvedValue([{
      id: 301, contactId: 61, plotSiteId: 30, status: 'PLOT_ASSIGNED',
      updatedAt: new Date('2026-10-06T10:00:00.000Z'),
    }]);
    prisma.plotSite.findMany.mockResolvedValue([{
      id: 30, name: 'Green Meadows', plotNumber: 'A-17', availability: 'RESERVED',
    }]);

    const response = await request(makeApp())
      .get('/api/pickup-plot-inventory/lead-status?contactIds=61,62');

    expect(response.status).toBe(200);
    expect(prisma.contact.findMany).toHaveBeenCalledWith({
      where: { tenantId: 7, id: { in: [61, 62] }, deletedAt: null },
      select: { id: true },
    });
    expect(prisma.customerPickup.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { tenantId: 7, contactId: { in: [61] } },
    }));
    expect(response.body.customers[0]).toMatchObject({
      contactId: 61,
      pickupAddress: '42 Lake View Road, Bengaluru',
      status: 'COMPLETED',
      transportPerson: { id: 41, name: 'Sant' },
      assignedPlots: [expect.objectContaining({ id: 30, plotNumber: 'A-17' })],
    });
    expect(response.body.pickupLocations).toEqual([expect.objectContaining({
      id: 4, name: 'Main Gate', address: '42 Lake View Road, Bengaluru',
    })]);
  });

  test('projects an assigned plot even when the lead has no pickup location', async () => {
    prisma.contact.findMany.mockResolvedValue([{ id: 61 }]);
    prisma.plotBooking.findMany.mockResolvedValue([{
      id: 301, contactId: 61, plotSiteId: 30, status: 'PLOT_ASSIGNED',
      updatedAt: new Date('2026-10-06T10:00:00.000Z'),
    }]);
    prisma.plotSite.findMany.mockResolvedValue([{
      id: 30, name: 'Green Meadows', plotNumber: 'A-17', availability: 'RESERVED',
    }]);

    const response = await request(makeApp())
      .get('/api/pickup-plot-inventory/lead-status?contactIds=61');

    expect(response.status).toBe(200);
    expect(response.body.customers).toEqual([expect.objectContaining({
      contactId: 61,
      pickupAddress: null,
      assignedPlot: expect.objectContaining({ id: 30, plotNumber: 'A-17' }),
      assignedPlots: [expect.objectContaining({ id: 30, plotNumber: 'A-17' })],
      currentStage: 'plot',
      currentStatus: 'PLOT_ASSIGNED',
    })]);
  });

  test('limits a USER lead-status projection to their assigned leads', async () => {
    prisma.contact.findMany.mockResolvedValue([]);

    const response = await request(makeApp({ role: 'USER' }))
      .get('/api/pickup-plot-inventory/lead-status?contactIds=61');

    expect(response.status).toBe(200);
    expect(response.body.customers).toEqual([]);
    expect(prisma.contact.findMany).toHaveBeenCalledWith({
      where: {
        tenantId: 7,
        id: { in: [61] },
        deletedAt: null,
        assignedToId: 3,
      },
      select: { id: true },
    });
    expect(prisma.customerPickup.findMany).not.toHaveBeenCalled();
  });

  test('projects converted customers with bounded, paginated history and scoped staff', async () => {
    prisma.contact.findMany.mockResolvedValue([{ id: 61 }]);
    prisma.customerPickup.findMany.mockResolvedValue([{ id: 91, contactId: 61, contact: { id: 61, status: 'Customer' } }]);
    prisma.$queryRaw.mockResolvedValue([{ id: 41 }]);
    prisma.plotWorkflowEvent.findMany.mockResolvedValue(Array.from({ length: 51 }, (_, index) => ({ id: index + 1, contactId: 61 })));
    const response = await request(makeApp()).get('/api/pickup-plot-inventory/lead-status?contactIds=61&historyPage=2');
    expect(response.status).toBe(200);
    expect(response.body.customers[0].contact.status).toBe('Customer');
    expect(response.body.customers[0].workflowHistory).toHaveLength(50);
    expect(response.body.customers[0].workflowHistoryPagination).toEqual({ page: 2, pageSize: 50, hasMore: true });
    expect(prisma.plotWorkflowEvent.findMany).toHaveBeenCalledWith({ where: { tenantId: 7, contactId: 61 }, orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }], skip: 50, take: 51 });
    expect(prisma.transportPerson.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { tenantId: 7, isActive: true, id: { in: [41] } } }));
    const query = prisma.$queryRaw.mock.calls[0][0];
    expect(query.sql).toContain('JSON_CONTAINS');
    expect(query.sql).toContain('LIMIT 201');
    expect(query.values).toContain(7);
    expect(query.values).toContain('61');
  });

  test('rejects an oversized staff projection instead of silently truncating it', async () => {
    prisma.contact.findMany.mockResolvedValue([{ id: 61 }]);
    prisma.$queryRaw.mockResolvedValue(Array.from({ length: 201 }, (_, id) => ({ id })));
    const response = await request(makeApp()).get('/api/pickup-plot-inventory/lead-status?contactIds=61');
    expect(response.status).toBe(413);
    expect(response.body.code).toBe('WORKFLOW_PROJECTION_TOO_LARGE');
    expect(prisma.transportPerson.findMany).not.toHaveBeenCalled();
  });

  test('allows billing workspace readers to open the customer workflow directory', async () => {
    prisma.billingPerson.findFirst.mockResolvedValue({ id: 9, assignmentPairsJson: JSON.stringify([{ customerId: 61, plotSiteId: 30 }]) });
    prisma.userRole.findMany.mockResolvedValue([{
      role: { permissions: [{ module: 'billing_workspace', action: 'read' }] },
    }]);

    const response = await request(makeApp({ role: 'USER', isOwner: false }))
      .get('/api/pickup-plot-inventory/customer-pickups');
    expect(response.status).toBe(200);
    expect(prisma.customerPickup.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { tenantId: 7, contactId: { in: [61] }, contact: { deletedAt: null } },
    }));
    expect(prisma.plotBooking.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { tenantId: 7, OR: [{ contactId: 61, plotSiteId: 30 }] },
    }));
  });

  test('denies billing readers without a linked profile before loading customer data', async () => {
    prisma.userRole.findMany.mockResolvedValue([{ role: { permissions: [{ module: 'billing_workspace', action: 'read' }] } }]);
    prisma.billingPerson.findFirst.mockResolvedValue(null);
    const response = await request(makeApp({ role: 'USER', isOwner: false }))
      .get('/api/pickup-plot-inventory/customer-pickups');
    expect(response.status).toBe(403);
    expect(response.body.code).toBe('BILLING_PROFILE_NOT_LINKED');
    expect(prisma.customerPickup.findMany).not.toHaveBeenCalled();
  });

  test('billing readers with no assignments cannot query the tenant directory', async () => {
    prisma.userRole.findMany.mockResolvedValue([{ role: { permissions: [{ module: 'billing_workspace', action: 'read' }] } }]);
    prisma.billingPerson.findFirst.mockResolvedValue({ id: 9, assignmentPairsJson: '[]', customerIdsJson: '[]' });
    const response = await request(makeApp({ role: 'USER', isOwner: false }))
      .get('/api/pickup-plot-inventory/customer-pickups');
    expect(response.status).toBe(200);
    expect(prisma.customerPickup.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ contactId: { in: [] } }),
    }));
    expect(prisma.plotBooking.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ OR: [{ id: -1 }] }),
    }));
    expect(prisma.payment.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ contactId: { in: [] } }),
    }));
  });

  test('denies the customer workflow directory without billing workspace access', async () => {
    prisma.userRole.findMany.mockResolvedValue([{ role: { permissions: [] } }]);

    const response = await request(makeApp({ role: 'USER', isOwner: false }))
      .get('/api/pickup-plot-inventory/customer-pickups');
    expect(response.status).toBe(403);
    expect(response.body.code).toBe('RBAC_DENIED');
  });
});
