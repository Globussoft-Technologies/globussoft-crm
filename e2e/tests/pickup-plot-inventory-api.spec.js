const { test, expect } = require('@playwright/test');

test.describe.configure({ mode: 'serial' });

const BASE_URL = process.env.BASE_URL || 'http://localhost:5000';
const IS_LOCAL_STACK = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(BASE_URL);
const RUN_TAG = `E2E_PICKUP_${process.pid}_${Date.now()}`;
let adminToken;
let userToken;
let locationId;
let plotId;
let transportPersonId;
let brokerId;

async function login(request, email) {
  const response = await request.post(`${BASE_URL}/api/auth/login`, {
    data: { email, password: 'password123' },
  });
  expect(response.ok()).toBeTruthy();
  return (await response.json()).token;
}

const headers = (token) => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' });

test.beforeAll(async ({ request }) => {
  test.skip(!IS_LOCAL_STACK, 'Inventory CRUD creates durable fixtures and runs only against the disposable CI-local stack.');
  adminToken = await login(request, 'admin@globussoft.com');
  userToken = await login(request, 'user@crm.com');
});

test('admin creates a pickup location with Google Maps link', async ({ request }) => {
  const response = await request.post(`${BASE_URL}/api/pickup-plot-inventory/locations`, {
    headers: headers(adminToken),
    data: {
      name: `${RUN_TAG} Main Gate`,
      address: '10 Test Avenue',
      googleMapsLink: 'https://maps.google.com/?q=12.9716,77.5946',
      isActive: true,
    },
  });
  expect(response.status()).toBe(201);
  const body = await response.json();
  locationId = body.id;
  expect(body.googleMapsLink).toContain('maps.google.com');
});

test('non-admin cannot create pickup locations', async ({ request }) => {
  const response = await request.post(`${BASE_URL}/api/pickup-plot-inventory/locations`, {
    headers: headers(userToken), data: { name: `${RUN_TAG} forbidden`, address: 'X' },
  });
  expect(response.status()).toBe(403);
});

test('non-admin cannot manage billing persons', async ({ request }) => {
  const response = await request.get(`${BASE_URL}/api/pickup-plot-inventory/billing-persons`, {
    headers: headers(userToken),
  });
  expect(response.status()).toBe(403);
});

test('customer pickup status directory is tenant-admin only', async ({ request }) => {
  const [adminResponse, userResponse] = await Promise.all([
    request.get(`${BASE_URL}/api/pickup-plot-inventory/customer-pickups`, { headers: headers(adminToken) }),
    request.get(`${BASE_URL}/api/pickup-plot-inventory/customer-pickups`, { headers: headers(userToken) }),
  ]);
  expect(adminResponse.status()).toBe(200);
  expect(await adminResponse.json()).toMatchObject({ customers: expect.any(Array), summary: expect.any(Object) });
  expect(userResponse.status()).toBe(403);
});

test('an unlinked user cannot read another driver assignment workspace', async ({ request }) => {
  const response = await request.get(`${BASE_URL}/api/pickup-plot-inventory/transport-persons/me`, {
    headers: headers(userToken),
  });
  expect(response.status()).toBe(403);
  expect((await response.json()).code).toBe('TRANSPORT_PROFILE_NOT_LINKED');
});

test('an unlinked user cannot read another broker customer workspace', async ({ request }) => {
  const response = await request.get(`${BASE_URL}/api/pickup-plot-inventory/brokers/me`, {
    headers: headers(userToken),
  });
  expect(response.status()).toBe(403);
  expect((await response.json()).code).toBe('BROKER_PROFILE_NOT_LINKED');
});

test('an unlinked user cannot advance another broker customer workflow', async ({ request }) => {
  const response = await request.patch(`${BASE_URL}/api/pickup-plot-inventory/brokers/me/customers/1/workflow`, {
    headers: headers(userToken),
    data: { status: 'EXPLANATION_STARTED' },
  });
  expect(response.status()).toBe(403);
  expect((await response.json()).code).toBe('BROKER_PROFILE_NOT_LINKED');
});

test('a user without the Billing role cannot access the billing queue', async ({ request }) => {
  const response = await request.get(`${BASE_URL}/api/pickup-plot-inventory/billing/me`, {
    headers: headers(userToken),
  });
  expect(response.status()).toBe(403);
  expect((await response.json()).code).toBe('BILLING_ROLE_REQUIRED');
});

test('admin creates and edits a plot assigned to the pickup location', async ({ request }) => {
  const created = await request.post(`${BASE_URL}/api/pickup-plot-inventory/plots`, {
    headers: headers(adminToken),
    data: {
      name: `${RUN_TAG} Plot A`, address: '25 Lake Road',
      area: '1200 sq ft', price: 250000, availability: 'AVAILABLE', isActive: true,
    },
  });
  expect(created.status()).toBe(201);
  plotId = (await created.json()).id;

  const updated = await request.put(`${BASE_URL}/api/pickup-plot-inventory/plots/${plotId}`, {
    headers: headers(adminToken),
    data: {
      name: `${RUN_TAG} Plot A`, address: '26 Lake Road',
      area: '1200 sq ft', price: 250000, availability: 'RESERVED', isActive: true,
    },
  });
  expect(updated.status()).toBe(200);
  expect(await updated.json()).toMatchObject({ availability: 'RESERVED', address: '26 Lake Road' });
});

test('list returns the tagged tenant-scoped location, plot, and summary', async ({ request }) => {
  const response = await request.get(`${BASE_URL}/api/pickup-plot-inventory`, { headers: headers(adminToken) });
  expect(response.status()).toBe(200);
  const body = await response.json();
  expect(body.pickupLocations.some((row) => row.id === locationId && row.name.includes(RUN_TAG))).toBeTruthy();
  expect(body.plots.some((row) => row.id === plotId && row.address === '26 Lake Road')).toBeTruthy();
  expect(body.summary.totalPlots).toBeGreaterThanOrEqual(1);
});

test('admin creates a transport person with pickup, plot, and structured service-area assignments', async ({ request }) => {
  const response = await request.post(`${BASE_URL}/api/pickup-plot-inventory/transport-persons`, {
    headers: headers(adminToken),
    data: {
      name: `Test Driver ${RUN_TAG.replace(/[^a-z]/gi, 'a')}`, phone: '9000011111', vehicleType: 'Mini truck', vehicleNumber: 'KA 01 AB 1234',
      pickupLocationIds: [locationId], plotSiteIds: [plotId],
      serviceAreas: [{ area: 'Koramangala', state: 'Karnataka', pincode: '560095' }],
    },
  });
  expect(response.status()).toBe(201);
  const body = await response.json();
  transportPersonId = body.id;
  expect(body.pickupLocationId).toBe(locationId);
  expect(body.pickupLocationIds).toEqual([locationId]);
  expect(body.plotSiteIds).toEqual([plotId]);
  expect(body.serviceAreas).toEqual([{ plotSiteId: null, area: 'Koramangala', state: 'Karnataka', pincode: '560095' }]);
});

test('admin creates a broker assigned to a plot', async ({ request }) => {
  const response = await request.post(`${BASE_URL}/api/pickup-plot-inventory/brokers`, {
    headers: headers(adminToken),
    data: { name: `Test Broker ${RUN_TAG.replace(/[^a-z]/gi, 'a')}`, phone: '9000022222', agency: 'E2E Realty', commissionPercent: 2.5, plotSiteId: plotId },
  });
  expect(response.status()).toBe(201);
  const body = await response.json();
  brokerId = body.id;
  expect(body.plotSiteId).toBe(plotId);
});

test('people directories return the newly created tenant-scoped records', async ({ request }) => {
  const [transportResponse, brokerResponse] = await Promise.all([
    request.get(`${BASE_URL}/api/pickup-plot-inventory/transport-persons`, { headers: headers(adminToken) }),
    request.get(`${BASE_URL}/api/pickup-plot-inventory/brokers`, { headers: headers(adminToken) }),
  ]);
  expect(transportResponse.status()).toBe(200);
  expect(brokerResponse.status()).toBe(200);
  expect((await transportResponse.json()).transportPersons.some((row) => row.id === transportPersonId)).toBeTruthy();
  expect((await brokerResponse.json()).brokers.some((row) => row.id === brokerId)).toBeTruthy();
});

test('admin can deactivate a pickup location and plot/site', async ({ request }) => {
  for (const [kind, id] of [['locations', locationId], ['plots', plotId]]) {
    const response = await request.patch(`${BASE_URL}/api/pickup-plot-inventory/${kind}/${id}/status`, {
      headers: headers(adminToken), data: { isActive: false },
    });
    expect(response.status()).toBe(200);
    expect((await response.json()).isActive).toBe(false);
  }
});
