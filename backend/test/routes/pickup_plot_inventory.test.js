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
prisma.plotInvoiceItem = prisma.plotInvoiceItem || {};
prisma.plotWorkflowEvent = prisma.plotWorkflowEvent || {};
prisma.contact = prisma.contact || {};
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
prisma.user.findMany = vi.fn();
prisma.user.create = vi.fn();
prisma.user.update = vi.fn();
prisma.role.findMany = vi.fn();
prisma.userRole.create = vi.fn();
prisma.transportPerson.findMany = vi.fn();
prisma.transportPerson.create = vi.fn();
prisma.transportPerson.update = vi.fn();
prisma.transportPerson.updateMany = vi.fn();
prisma.plotBroker.findMany = vi.fn();
prisma.plotBroker.create = vi.fn();
prisma.plotBroker.update = vi.fn();
prisma.plotBroker.updateMany = vi.fn();
prisma.billingPerson.findMany = vi.fn();
prisma.billingPerson.create = vi.fn();
prisma.billingPerson.update = vi.fn();
prisma.customerPickup.findMany = vi.fn();
prisma.customerPickup.findUnique = vi.fn();
prisma.customerPickup.upsert = vi.fn();
prisma.invoice.findFirst = vi.fn();
prisma.invoice.create = vi.fn();
prisma.invoice.update = vi.fn();
prisma.payment.create = vi.fn();
prisma.payment.findFirst = vi.fn();
prisma.payment.update = vi.fn();
prisma.plotBooking.findFirst = vi.fn();
prisma.plotBooking.findMany = vi.fn();
prisma.plotBooking.create = vi.fn();
prisma.plotBooking.update = vi.fn();
prisma.plotInvoiceItem.create = vi.fn();
prisma.plotWorkflowEvent.create = vi.fn();
prisma.plotWorkflowEvent.findMany = vi.fn();
prisma.$transaction = vi.fn(async (callback) => callback(prisma));

const auth = requireCJS('../../middleware/auth');
auth.verifyToken = (_req, _res, next) => next();
const router = requireCJS('../../routes/pickup_plot_inventory');

function makeApp({ tenantId = 7, role = 'ADMIN' } = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { userId: 3, tenantId, role, vertical: 'generic' };
    next();
  });
  app.use('/api/pickup-plot-inventory', router);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  prisma.plotSite.updateMany.mockResolvedValue({ count: 1 });
  prisma.tenant.findUnique = vi.fn().mockResolvedValue({ vertical: 'generic' });
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
  prisma.plotBooking.findFirst.mockResolvedValue(null);
  prisma.plotBooking.findMany.mockResolvedValue([]);
  prisma.plotBooking.create.mockResolvedValue({ id: 91, bookingNumber: 'BOOK-TEST', status: 'PLOT_RESERVED' });
  prisma.plotBooking.update.mockResolvedValue({ id: 91 });
  prisma.plotInvoiceItem.create.mockResolvedValue({ id: 101 });
  prisma.plotWorkflowEvent.create.mockResolvedValue({ id: 111 });
  prisma.plotWorkflowEvent.findMany.mockResolvedValue([]);
  prisma.payment.findFirst.mockResolvedValue(null);
  emailSender.sendEmail.mockResolvedValue({ sent: true });
  smsProvider.resolveProviderConfig.mockResolvedValue(null);
  smsProvider.sendSms.mockResolvedValue({ success: true });
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
  });

  test('rejects an invalid phone number', async () => {
    const response = await request(makeApp()).post('/api/pickup-plot-inventory/transport-persons').send({
      name: 'Ravi Kumar', phone: '123',
    });
    expect(response.status).toBe(400);
    expect(response.body.error).toMatch(/7 to 15 digits/);
    expect(prisma.transportPerson.create).not.toHaveBeenCalled();
  });

  test('creates a staff login with the Transport Person role from the transport page', async () => {
    prisma.role.findMany.mockResolvedValue([{ id: 8, key: 'transport_person', name: 'Transport person' }]);
    prisma.user.findFirst.mockResolvedValue(null);
    prisma.user.create.mockResolvedValue({ id: 81 });
    prisma.userRole.create.mockResolvedValue({ id: 91 });
    prisma.transportPerson.create.mockResolvedValue({
      id: 41, userId: 81, name: 'Ravi Kumar', phone: '9000011111',
      user: { id: 81, name: 'Ravi Kumar', email: 'ravi@example.com', phone: '9000011111' },
    });

    const response = await request(makeApp()).post('/api/pickup-plot-inventory/transport-persons').send({
      name: 'Ravi Kumar', phone: '9000011111', email: 'ravi@example.com', password: 'Secret123',
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

  test('links an existing staff member with the Transport Person role', async () => {
    prisma.user.findFirst.mockResolvedValue({
      id: 82, tenantId: 7, userRoles: [{ role: { id: 8, key: 'transport_person', name: 'Transport person' } }],
    });
    prisma.transportPerson.findFirst.mockResolvedValue(null);
    prisma.transportPerson.create.mockResolvedValue({ id: 42, userId: 82, name: 'Mohan Das', phone: '9000022222' });

    const response = await request(makeApp()).post('/api/pickup-plot-inventory/transport-persons').send({
      name: 'Mohan Das', phone: '9000022222', staffUserId: 82,
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
      name: 'Ravi Kumar', phone: '9000011111', plotSiteIds: [30], customerIds: [61],
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
      name: 'Ravi Kumar', phone: '9000011111', plotSiteIds: [30], customerIds: [61],
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
      name: 'Sant', phone: '9000011111', plotSiteIds: [31], customerIds: [62],
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
    expect(prisma.transportPerson.findMany.mock.calls[0][0].where).toEqual({ tenantId: 7 });
    expect(prisma.pickupLocation.findMany.mock.calls[0][0].where).toEqual({ tenantId: 7 });
    expect(prisma.customerPickup.findMany.mock.calls[0][0]).toEqual(expect.objectContaining({
      where: { tenantId: 7, contact: { deletedAt: null } },
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

  test('lists unlinked staff who have the Transport Person role', async () => {
    prisma.transportPerson.findMany.mockResolvedValue([{
      id: 41, name: 'Ravi Kumar', phone: '9000011111', userId: 81, isActive: true,
      user: { id: 81, name: 'Ravi Kumar', email: 'ravi@example.com', phone: '9000011111' },
    }]);
    prisma.role.findMany.mockResolvedValue([{ id: 8, key: 'transport_person', name: 'Transport person' }]);
    prisma.user.findMany.mockResolvedValue([
      { id: 81, name: 'Ravi Kumar', email: 'ravi@example.com', phone: '9000011111' },
      { id: 82, name: 'Sant Kumar', email: 'sant@example.com', phone: '9000099999' },
    ]);

    const response = await request(makeApp()).get('/api/pickup-plot-inventory/transport-persons');

    expect(response.status).toBe(200);
    expect(response.body.transportRole).toMatchObject({ id: 8, name: 'Transport person' });
    expect(response.body.staffUsers).toEqual([
      { id: 82, name: 'Sant Kumar', email: 'sant@example.com', phone: '9000099999' },
    ]);
    expect(prisma.user.findMany.mock.calls[0][0].where).toMatchObject({
      tenantId: 7, userRoles: { some: { roleId: 8 } },
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
      name: 'Ravi Kumar', phone: '9000011111', plotSiteIds: [], customerIds: [],
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
      workflowStatusJson: '{"customer-61":{"status":"VISIT_SCHEDULED","updatedAt":"2026-10-06T11:00:00.000Z","visitScheduledAt":"2026-10-07T10:00:00.000Z"}}',
      isActive: true,
    });
    prisma.contact.findMany.mockResolvedValue([
      { id: 61, name: 'Li Wei', phone: '9000022222', company: 'Shenzhen Micro Ltd' },
      { id: 62, name: 'Priyanka Mehta', phone: '9000033333', company: 'Acme India' },
    ]);
    prisma.plotSite.findMany.mockResolvedValue([
      { id: 30, name: 'Plot 24', address: 'North Avenue' },
      { id: 31, name: 'Plot 25', address: 'South Avenue' },
    ]);
    prisma.transportPerson.findMany.mockResolvedValue([{
      customerIdsJson: '[61,62]', plotSiteIdsJson: '[30,31]',
      assignmentStatusJson: '{"customer-61":{"status":"COMPLETED","updatedAt":"2026-10-06T10:00:00.000Z"},"customer-62":{"status":"PICKED_UP"}}',
    }]);

    const response = await request(makeApp({ role: 'USER' })).get('/api/pickup-plot-inventory/brokers/me');

    expect(response.status).toBe(200);
    expect(response.body.summary).toEqual({ total: 2, completed: 1, waiting: 1 });
    expect(response.body.customers).toEqual([
      expect.objectContaining({
        id: 61, tripCompleted: true, tripMessage: 'Trip completed', plot: expect.objectContaining({ id: 30 }),
        brokerWorkflow: { status: 'VISIT_SCHEDULED', updatedAt: '2026-10-06T11:00:00.000Z', visitScheduledAt: '2026-10-07T10:00:00.000Z' },
      }),
      expect.objectContaining({ id: 62, tripCompleted: false, tripMessage: 'Trip not completed', plot: expect.objectContaining({ id: 31 }) }),
    ]);
    expect(response.body.customers[1]).not.toHaveProperty('status');
    expect(response.body.customers[1]).not.toHaveProperty('brokerWorkflow');
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
      .send({ status: 'PLOT_SELECTED' });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ status: 'PLOT_SELECTED', handedToBilling: true, bookingStatus: 'PLOT_RESERVED' });
    expect(prisma.plotSite.updateMany).toHaveBeenCalledWith({ where: { id: 30, tenantId: 7, isActive: true, availability: 'AVAILABLE' }, data: { availability: 'RESERVED' } });
    expect(prisma.plotBooking.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ contactId: 61, plotSiteId: 30, transportPersonId: 41, plotBrokerId: 51 }),
    }));
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
    prisma.plotSite.findMany.mockResolvedValue([{ id: 30, name: 'Plot 24', price: 250000 }]);

    const response = await request(makeApp({ role: 'USER' })).get('/api/pickup-plot-inventory/billing/me');

    expect(response.status).toBe(200);
    expect(response.body.assignments).toEqual([expect.objectContaining({
      assignmentKey: '51-61-30', status: 'INVOICE_CREATED',
      customer: expect.objectContaining({ name: 'Li Wei' }), broker: { id: 51, name: 'Sanjeev' },
    })]);
    expect(response.body.waitingAssignments).toEqual([]);
    expect(response.body.summary).toEqual({ total: 1, waiting: 0, active: 1, completed: 0 });
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

  test('lists billing persons and unlinked Billing-role staff', async () => {
    prisma.role.findMany.mockResolvedValue([{ id: 10, key: 'BILLING', name: 'Billing Department' }]);
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

  test('links an existing Billing-role staff user to a billing person profile', async () => {
    prisma.user.findFirst.mockResolvedValue({
      id: 22, name: 'Ravi Billing', email: 'ravi@example.com', phone: '9000022222',
      userRoles: [{ role: { key: 'BILLING', name: 'Billing Department' } }],
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

  test('does not let an unlinked user open a broker workspace', async () => {
    prisma.plotBroker.findFirst.mockResolvedValue(null);
    const response = await request(makeApp({ role: 'USER' })).get('/api/pickup-plot-inventory/brokers/me');
    expect(response.status).toBe(403);
    expect(response.body.code).toBe('BROKER_PROFILE_NOT_LINKED');
  });

  test('lists unlinked staff with either Broker or BROOKER role spelling', async () => {
    prisma.role.findMany.mockResolvedValue([{ id: 8, key: 'BROOKER', name: 'BROOKER' }]);
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
    expect(response.body.staffRole).toMatchObject({ id: 8, key: 'BROOKER' });
    expect(response.body.staffUsers).toEqual([
      expect.objectContaining({ id: 18, email: 'sanjeev@example.com' }),
    ]);
    expect(response.body.customers).toEqual([
      expect.objectContaining({ id: 61, name: 'Priya Lead' }),
    ]);
    expect(prisma.user.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ tenantId: 7, userRoles: { some: { roleId: 8 } } }),
    }));
  });

  test('links an existing Broker staff user to a new broker profile', async () => {
    prisma.user.findFirst.mockResolvedValue({
      id: 18, name: 'Sanjeev Rao', email: 'sanjeev@example.com', phone: '9000033333',
      userRoles: [{ role: { id: 8, key: 'BROOKER', name: 'BROOKER' } }],
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
    prisma.role.findMany.mockResolvedValue([{ id: 8, key: 'BROKER', name: 'Broker' }]);
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

    const response = await request(makeApp({ tenantId: 7 })).get('/api/pickup-plot-inventory');
    expect(response.status).toBe(200);
    expect(response.body.pickupLocations[0].plotCount).toBe(2);
    expect(response.body.pickupLocations[0].assignedCount).toBe(2);
    expect(response.body.summary).toEqual({
      activeLocations: 1, totalPlots: 2, availablePlots: 1, reservedPlots: 1, soldPlots: 0,
    });
    expect(prisma.pickupLocation.findMany.mock.calls[0][0].where).toEqual({ tenantId: 7 });
    expect(prisma.plotSite.findMany.mock.calls[0][0].where).toEqual({ tenantId: 7 });
  });
});

describe('pickup location mutations', () => {
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
  test('accepts the UI default shape with no pickup location and a blank optional price', async () => {
    prisma.plotSite.create.mockResolvedValue({ id: 29, name: 'plot-1', address: '25 Lake Road', price: null, pickupLocationId: null });
    const response = await request(makeApp()).post('/api/pickup-plot-inventory/plots').send({
      name: 'plot-1', address: '25 Lake Road', area: '', price: '',
      availability: 'AVAILABLE', notes: '', isActive: true,
    });
    expect(response.status).toBe(201);
    expect(prisma.plotSite.create).toHaveBeenCalledWith({ data: expect.objectContaining({
      name: 'plot-1', address: '25 Lake Road', pickupLocationId: null, price: null, tenantId: 7,
    }) });
  });

  test('creates an available plot linked only to a location in the same tenant', async () => {
    prisma.pickupLocation.findMany.mockResolvedValue([{ id: 4 }]);
    prisma.plotSite.create.mockResolvedValue({ id: 30, name: 'Plot 30' });
    const response = await request(makeApp()).post('/api/pickup-plot-inventory/plots').send({
      name: 'Plot 30', pickupLocationId: 4, referenceCode: 'P-30', area: '1200 sq ft',
      price: '250000', availability: 'AVAILABLE',
    });
    expect(response.status).toBe(201);
    expect(prisma.pickupLocation.findMany).toHaveBeenCalledWith({ where: { id: { in: [4] }, tenantId: 7 }, select: { id: true } });
    expect(prisma.plotSite.create).toHaveBeenCalledWith({ data: expect.objectContaining({
      name: 'Plot 30', pickupLocationId: 4, price: 250000, tenantId: 7,
    }) });
  });

  test('stores interactive master-plan plot details and the new availability values', async () => {
    prisma.plotSite.create.mockImplementation(async ({ data }) => ({ id: 32, ...data }));
    const response = await request(makeApp()).post('/api/pickup-plot-inventory/plots').send({
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
      name: 'Surveyed Plot', availability: 'AVAILABLE', boundary,
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
    const response = await request(makeApp()).post('/api/pickup-plot-inventory/plots').send({ name: 'Plot X', availability: 'HIDDEN' });
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
      where: { id: 61, tenantId: 7, deletedAt: null }, select: { id: true },
    });
    expect(prisma.customerPickup.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { tenantId_contactId: { tenantId: 7, contactId: 61 } },
      create: expect.objectContaining({
        tenantId: 7, contactId: 61, pickupAddress: '42 Lake View Road, Bengaluru',
        sourceTranscriptId: '789', capturedByUserId: 3,
      }),
    }));
    expect(response.body.status).toBe('PICKUP_LOCATION_CAPTURED');
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
      assignmentStatusJson: '{"customer-61":{"status":"PICKED_UP","updatedAt":"2026-10-06T11:00:00.000Z"}}',
      updatedAt: new Date('2026-10-06T10:30:00.000Z'),
    }]);
    prisma.plotSite.findMany.mockResolvedValue([{
      id: 30, name: 'Plot 24', address: 'North Avenue', area: '1200 sq ft', availability: 'RESERVED',
    }]);
    prisma.plotBroker.findMany.mockResolvedValue([{
      id: 51, name: 'Sanjeev', phone: '9000044444', customerIdsJson: '[61]',
      workflowStatusJson: '{"customer-61":{"status":"INTEREST_CONFIRMED","updatedAt":"2026-10-06T12:00:00.000Z","billingStatus":"INVOICE_SENT","billingUpdatedAt":"2026-10-06T13:00:00.000Z"}}',
    }]);

    const response = await request(makeApp()).get('/api/pickup-plot-inventory/customer-pickups');

    expect(response.status).toBe(200);
    expect(response.body.customers[0]).toMatchObject({
      pickupAddress: '42 Lake View Road, Bengaluru', status: 'PICKED_UP',
      transportPerson: { id: 41, name: 'Sant' },
      assignedPlot: { id: 30, name: 'Plot 24', address: 'North Avenue' },
      currentStage: 'transport', currentStatus: 'PICKED_UP',
      workflow: {
        transport: { status: 'PICKED_UP', assignee: { id: 41, name: 'Sant' } },
        broker: { status: 'PLOT_SELECTED', assignee: { id: 51, name: 'Sanjeev' } },
        billing: { status: 'INVOICE_SENT' },
      },
    });
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
  });

  test('requires admin access to the customer status directory', async () => {
    const response = await request(makeApp({ role: 'USER' })).get('/api/pickup-plot-inventory/customer-pickups');
    expect(response.status).toBe(403);
  });
});
