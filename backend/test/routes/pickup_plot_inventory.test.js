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
prisma.contact = prisma.contact || {};
prisma.role = prisma.role || {};
prisma.user = prisma.user || {};
prisma.userRole = prisma.userRole || {};
prisma.user = prisma.user || {};
prisma.role = prisma.role || {};
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
prisma.contact.findMany = vi.fn();
prisma.user.findMany = vi.fn();
prisma.user.create = vi.fn();
prisma.user.update = vi.fn();
prisma.role.findMany = vi.fn();
prisma.userRole.create = vi.fn();
prisma.transportPerson.findMany = vi.fn();
prisma.transportPerson.create = vi.fn();
prisma.transportPerson.update = vi.fn();
prisma.plotBroker.findMany = vi.fn();
prisma.plotBroker.create = vi.fn();
prisma.plotBroker.update = vi.fn();
prisma.billingPerson.findMany = vi.fn();
prisma.billingPerson.create = vi.fn();
prisma.billingPerson.update = vi.fn();
prisma.customerPickup.findMany = vi.fn();
prisma.customerPickup.upsert = vi.fn();
prisma.role.findMany = vi.fn();
prisma.user.findFirst = vi.fn();
prisma.user.findMany = vi.fn();
prisma.user.create = vi.fn();
prisma.userRole.create = vi.fn();
prisma.$transaction = vi.fn(async (callback) => callback(prisma));
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
  prisma.tenant.findFirst.mockResolvedValue({ vertical: 'generic' });
  prisma.pickupLocation.findMany.mockResolvedValue([]);
  prisma.plotSite.findMany.mockResolvedValue([]);
  prisma.contact.findMany.mockResolvedValue([]);
  prisma.transportPerson.findMany.mockResolvedValue([]);
  prisma.plotBroker.findMany.mockResolvedValue([]);
  prisma.billingPerson.findMany.mockResolvedValue([]);
  prisma.billingPerson.findFirst.mockResolvedValue(null);
  prisma.customerPickup.findMany.mockResolvedValue([]);
  prisma.role.findMany.mockResolvedValue([]);
  prisma.user.findFirst.mockResolvedValue(null);
  prisma.user.findMany.mockResolvedValue([]);
  prisma.contact.findFirst.mockResolvedValue(null);
  emailSender.sendEmail.mockResolvedValue({ sent: true });
  smsProvider.resolveProviderConfig.mockResolvedValue(null);
  smsProvider.sendSms.mockResolvedValue({ success: true });
  prisma.user.findMany.mockResolvedValue([]);
  prisma.role.findMany.mockResolvedValue([]);
  prisma.pickupLocation.findFirst.mockResolvedValue(null);
  prisma.plotSite.findFirst.mockResolvedValue(null);
});

describe('transport person mutations', () => {
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

    expect(response.status).toBe(200);
    expect(prisma.transportPerson.findFirst).toHaveBeenCalledWith({
      where: { tenantId: 7, userId: 3, isActive: true },
    });
    expect(response.body.assignments).toEqual([expect.objectContaining({
      assignmentKey: 'customer-61', status: 'ASSIGNED',
      customer: expect.objectContaining({ name: 'Priya Shah' }),
      pickup: expect.objectContaining({ name: 'North Gate' }),
      drop: expect.objectContaining({ name: 'Green Acres' }),
    })]);
    expect(response.body.summary).toEqual({ total: 1, active: 1, completed: 0 });
  });

  test('advances only the signed-in driver assignment to the next status', async () => {
    prisma.transportPerson.findFirst.mockResolvedValue({
      id: 41, userId: 3, tenantId: 7, pickupLocationId: 4,
      pickupLocationIdsJson: '[4]', plotSiteIdsJson: '[30]', customerIdsJson: '[61]',
      assignmentStatusJson: '{"customer-61":{"status":"ACCEPTED","updatedAt":"2026-10-06T10:00:00.000Z"}}',
      isActive: true,
    });
    prisma.transportPerson.update.mockResolvedValue({ id: 41 });

    const response = await request(makeApp({ role: 'USER' }))
      .patch('/api/pickup-plot-inventory/transport-persons/me/assignments/customer-61/status')
      .send({ status: 'HEADING_TO_PICKUP' });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ assignmentKey: 'customer-61', status: 'HEADING_TO_PICKUP' });
    const update = prisma.transportPerson.update.mock.calls[0][0];
    expect(update.where).toEqual({ id: 41 });
    expect(JSON.parse(update.data.assignmentStatusJson)['customer-61'].status).toBe('HEADING_TO_PICKUP');
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

    expect(response.status).toBe(200);
    expect(response.body.assignments[0].pickup).toEqual(expect.objectContaining({
      name: 'Customer pickup', address: '42 Lake View Road, Bengaluru', source: 'CALLIFIED_TRANSCRIPT',
    }));
  });

  test('rejects a driver status jump', async () => {
    prisma.transportPerson.findFirst.mockResolvedValue({
      id: 41, userId: 3, tenantId: 7, customerIdsJson: '[61]', assignmentStatusJson: null, isActive: true,
    });
    const response = await request(makeApp({ role: 'USER' }))
      .patch('/api/pickup-plot-inventory/transport-persons/me/assignments/customer-61/status')
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
  test('lists every assigned broker customer but exposes only completed trip state', async () => {
    prisma.plotBroker.findFirst.mockResolvedValue({
      id: 51, userId: 3, tenantId: 7, name: 'Sanjeev', phone: '9000011111', agency: 'Prime Realty',
      commissionPercent: 2.5, customerIdsJson: '[61,62]', plotSiteIdsJson: '[30,31]',
      workflowStatusJson: '{"customer-61":{"status":"EXPLANATION_STARTED","updatedAt":"2026-10-06T11:00:00.000Z"}}',
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
      customerIdsJson: '[61,62]',
      assignmentStatusJson: '{"customer-61":{"status":"COMPLETED","updatedAt":"2026-10-06T10:00:00.000Z"},"customer-62":{"status":"PICKED_UP"}}',
    }]);

    const response = await request(makeApp({ role: 'USER' })).get('/api/pickup-plot-inventory/brokers/me');

    expect(response.status).toBe(200);
    expect(response.body.summary).toEqual({ total: 2, completed: 1, waiting: 1 });
    expect(response.body.customers).toEqual([
      expect.objectContaining({
        id: 61, tripCompleted: true, tripMessage: 'Trip completed', plot: expect.objectContaining({ id: 30 }),
        brokerWorkflow: { status: 'EXPLANATION_STARTED', updatedAt: '2026-10-06T11:00:00.000Z' },
      }),
      expect.objectContaining({ id: 62, tripCompleted: false, tripMessage: 'Trip not completed', plot: expect.objectContaining({ id: 31 }) }),
    ]);
    expect(response.body.customers[1]).not.toHaveProperty('status');
    expect(response.body.customers[1]).not.toHaveProperty('brokerWorkflow');
  });

  test('advances a completed-trip customer through the broker workflow in order', async () => {
    prisma.plotBroker.findFirst.mockResolvedValue({
      id: 51, userId: 3, tenantId: 7, customerIdsJson: '[61]',
      workflowStatusJson: '{"customer-61":{"status":"EXPLANATION_STARTED"}}', isActive: true,
    });
    prisma.transportPerson.findMany.mockResolvedValue([{
      customerIdsJson: '[61]', assignmentStatusJson: '{"customer-61":{"status":"COMPLETED"}}',
    }]);
    prisma.plotBroker.update.mockResolvedValue({ id: 51 });

    const response = await request(makeApp({ role: 'USER' }))
      .patch('/api/pickup-plot-inventory/brokers/me/customers/61/workflow')
      .send({ status: 'EXPLANATION_COMPLETED' });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ customerId: 61, status: 'EXPLANATION_COMPLETED' });
    const update = prisma.plotBroker.update.mock.calls[0][0];
    expect(update.where).toEqual({ id: 51 });
    expect(JSON.parse(update.data.workflowStatusJson)['customer-61'].status).toBe('EXPLANATION_COMPLETED');
  });

  test('does not start broker work before the customer trip is completed', async () => {
    prisma.plotBroker.findFirst.mockResolvedValue({
      id: 51, userId: 3, tenantId: 7, customerIdsJson: '[61]', workflowStatusJson: null, isActive: true,
    });
    prisma.transportPerson.findMany.mockResolvedValue([{
      customerIdsJson: '[61]', assignmentStatusJson: '{"customer-61":{"status":"PICKED_UP"}}',
    }]);

    const response = await request(makeApp({ role: 'USER' }))
      .patch('/api/pickup-plot-inventory/brokers/me/customers/61/workflow')
      .send({ status: 'EXPLANATION_STARTED' });

    expect(response.status).toBe(409);
    expect(response.body.code).toBe('TRIP_NOT_COMPLETED');
    expect(prisma.plotBroker.update).not.toHaveBeenCalled();
  });

  test('hands an interested customer to the billing department', async () => {
    prisma.plotBroker.findFirst.mockResolvedValue({
      id: 51, userId: 3, tenantId: 7, customerIdsJson: '[61]',
      workflowStatusJson: '{"customer-61":{"status":"EXPLANATION_COMPLETED"}}', isActive: true,
    });
    prisma.transportPerson.findMany.mockResolvedValue([{
      customerIdsJson: '[61]', assignmentStatusJson: '{"customer-61":{"status":"COMPLETED"}}',
    }]);
    prisma.plotBroker.update.mockResolvedValue({ id: 51 });

    const response = await request(makeApp({ role: 'USER' }))
      .patch('/api/pickup-plot-inventory/brokers/me/customers/61/workflow')
      .send({ status: 'INTEREST_CONFIRMED' });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ status: 'INTEREST_CONFIRMED', handedToBilling: true });
  });

  test('closes a not-interested customer and sends the thank-you email', async () => {
    prisma.plotBroker.findFirst.mockResolvedValue({
      id: 51, userId: 3, tenantId: 7, customerIdsJson: '[61]',
      workflowStatusJson: '{"customer-61":{"status":"EXPLANATION_COMPLETED"}}', isActive: true,
    });
    prisma.transportPerson.findMany.mockResolvedValue([{
      customerIdsJson: '[61]', assignmentStatusJson: '{"customer-61":{"status":"COMPLETED"}}',
    }]);
    prisma.contact.findFirst.mockResolvedValue({ id: 61, name: 'Li Wei', email: 'li@example.com', phone: '9000022222' });
    prisma.plotBroker.update.mockResolvedValue({ id: 51 });

    const response = await request(makeApp({ role: 'USER' }))
      .patch('/api/pickup-plot-inventory/brokers/me/customers/61/workflow')
      .send({ status: 'NOT_INTERESTED' });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ status: 'NOT_INTERESTED', handedToBilling: false, messageDelivery: { sent: true, channel: 'email' } });
    expect(emailSender.sendEmail).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: 7, to: 'li@example.com', subject: 'Thank you for your interest',
    }));
  });

  test('lists interested customers in the billing workspace', async () => {
    prisma.user.findFirst.mockResolvedValue({
      id: 3, name: 'Bina', email: 'billing@example.com',
      userRoles: [{ role: { key: 'BILLING', name: 'Billing Department' } }],
    });
    prisma.billingPerson.findFirst.mockResolvedValue({ id: 71, userId: 3, name: 'Bina', isActive: true });
    prisma.plotBroker.findMany.mockResolvedValue([{
      id: 51, tenantId: 7, name: 'Sanjeev', customerIdsJson: '[61,62]', plotSiteIdsJson: '[30,31]',
      workflowStatusJson: '{"customer-61":{"status":"INTEREST_CONFIRMED","billingStatus":"INVOICE_PREPARED"},"customer-62":{"status":"NOT_INTERESTED"}}',
      isActive: true,
    }]);
    prisma.contact.findMany.mockResolvedValue([{ id: 61, name: 'Li Wei', email: 'li@example.com' }]);
    prisma.plotSite.findMany.mockResolvedValue([{ id: 30, name: 'Plot 24', price: 250000 }]);

    const response = await request(makeApp({ role: 'USER' })).get('/api/pickup-plot-inventory/billing/me');

    expect(response.status).toBe(200);
    expect(response.body.assignments).toEqual([expect.objectContaining({
      assignmentKey: '51-61', status: 'INVOICE_PREPARED',
      customer: expect.objectContaining({ name: 'Li Wei' }), broker: { id: 51, name: 'Sanjeev' },
    })]);
    expect(response.body.summary).toEqual({ total: 1, active: 1, completed: 0 });
  });

  test('advances billing assignments sequentially', async () => {
    prisma.user.findFirst.mockResolvedValue({
      id: 3, userRoles: [{ role: { key: 'BILLING' } }],
    });
    prisma.billingPerson.findFirst.mockResolvedValue({ id: 71, userId: 3, name: 'Bina', isActive: true });
    prisma.plotBroker.findFirst.mockResolvedValue({
      id: 51, tenantId: 7, customerIdsJson: '[61]',
      workflowStatusJson: '{"customer-61":{"status":"INTEREST_CONFIRMED","billingStatus":"DETAILS_VERIFIED"}}',
      isActive: true,
    });
    prisma.plotBroker.update.mockResolvedValue({ id: 51 });

    const response = await request(makeApp({ role: 'USER' }))
      .patch('/api/pickup-plot-inventory/billing/me/assignments/51-61/status')
      .send({ status: 'INVOICE_PREPARED' });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ assignmentKey: '51-61', status: 'INVOICE_PREPARED' });
    const saved = JSON.parse(prisma.plotBroker.update.mock.calls[0][0].data.workflowStatusJson)['customer-61'];
    expect(saved).toMatchObject({ status: 'INTEREST_CONFIRMED', billingStatus: 'INVOICE_PREPARED' });
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

  test('links an existing Billing-role staff user to a billing person profile', async () => {
    prisma.user.findFirst.mockResolvedValue({
      id: 22, name: 'Ravi Billing', email: 'ravi@example.com', phone: '9000022222',
      userRoles: [{ role: { key: 'BILLING', name: 'Billing Department' } }],
    });
    prisma.billingPerson.findFirst.mockResolvedValue(null);
    prisma.contact.findMany.mockResolvedValue([{ id: 61 }]);
    prisma.plotSite.findMany.mockResolvedValue([{ id: 30 }]);
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
    prisma.plotBroker.create.mockResolvedValue({ id: 51, name: 'Asha', phone: '9000022222', plotSiteId: 30, plotSiteIdsJson: '[30,31]', customerIdsJson: '[61,62]' });
    const response = await request(makeApp()).post('/api/pickup-plot-inventory/brokers').send({
      name: 'Asha', phone: '9000022222', agency: 'Prime Plots', commissionPercent: '2.5', plotSiteIds: [30, 31],
      customerIds: [61, 62],
    });
    expect(response.status).toBe(201);
    expect(prisma.plotSite.findMany).toHaveBeenCalledWith({ where: { id: { in: [30, 31] }, tenantId: 7 }, select: { id: true } });
    expect(prisma.plotBroker.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({
      name: 'Asha', commissionPercent: 2.5, plotSiteId: 30, plotSiteIdsJson: '[30,31]', customerIdsJson: '[61,62]', tenantId: 7,
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
      googleMapsLink: 'https://maps.google.com/?q=12,77', isActive: true,
    });
    expect(response.status).toBe(201);
    expect(prisma.pickupLocation.create).toHaveBeenCalledWith({ data: expect.objectContaining({
      name: 'Main Gate', address: '10 Market Road', tenantId: 7,
      googleMapsLink: 'https://maps.google.com/?q=12,77',
    }) });
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
    prisma.pickupLocation.findFirst.mockResolvedValue({ id: 4 });
    prisma.plotSite.create.mockResolvedValue({ id: 30, name: 'Plot 30' });
    const response = await request(makeApp()).post('/api/pickup-plot-inventory/plots').send({
      name: 'Plot 30', pickupLocationId: 4, referenceCode: 'P-30', area: '1200 sq ft',
      price: '250000', availability: 'AVAILABLE',
    });
    expect(response.status).toBe(201);
    expect(prisma.pickupLocation.findFirst).toHaveBeenCalledWith({ where: { id: 4, tenantId: 7 }, select: { id: true } });
    expect(prisma.plotSite.create).toHaveBeenCalledWith({ data: expect.objectContaining({
      name: 'Plot 30', pickupLocationId: 4, price: 250000, tenantId: 7,
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
        pickupAddress: ' 42 Lake View Road, Bengaluru ',
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
      id: 91, tenantId: 7, contactId: 61, pickupAddress: '42 Lake View Road, Bengaluru',
      sourceTranscriptId: '789', updatedAt: new Date('2026-10-06T10:00:00.000Z'),
      contact: { id: 61, name: 'Priya Shah', status: 'Lead' },
    }]);
    prisma.transportPerson.findMany.mockResolvedValue([{
      id: 41, name: 'Sant', phone: '9000011111', customerIdsJson: '[61]',
      assignmentStatusJson: '{"customer-61":{"status":"PICKED_UP","updatedAt":"2026-10-06T11:00:00.000Z"}}',
      updatedAt: new Date('2026-10-06T10:30:00.000Z'),
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
      currentStage: 'transport', currentStatus: 'PICKED_UP',
      workflow: {
        transport: { status: 'PICKED_UP', assignee: { id: 41, name: 'Sant' } },
        broker: { status: 'INTEREST_CONFIRMED', assignee: { id: 51, name: 'Sanjeev' } },
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

    const response = await request(makeApp()).get('/api/pickup-plot-inventory/customer-pickups');

    expect(response.status).toBe(200);
    expect(response.body.customers[0]).toMatchObject({
      status: 'COMPLETED', currentStage: 'billing', currentStatus: 'PAYMENT_RECEIVED',
      currentStatusUpdatedAt: '2026-10-06T13:00:00.000Z',
    });
  });

  test('requires admin access to the customer status directory', async () => {
    const response = await request(makeApp({ role: 'USER' })).get('/api/pickup-plot-inventory/customer-pickups');
    expect(response.status).toBe(403);
  });
});
