const { test, expect } = require('@playwright/test');

// This request-only suite authenticates explicitly; it must not depend on
// the browser setup project's saved session when run by itself.
test.use({ storageState: { cookies: [], origins: [] } });
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
let externalApiKey;
let externalApiKeyId;

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

  const keyResponse = await request.post(`${BASE_URL}/api/developer/apikeys`, {
    headers: headers(adminToken),
    data: { name: `${RUN_TAG} plot inventory`, purpose: 'plot-inventory-read' },
  });
  expect(keyResponse.status()).toBe(201);
  const keyBody = await keyResponse.json();
  externalApiKey = keyBody.rawKey;
  externalApiKeyId = keyBody.key.id;
});

test.afterAll(async ({ request }) => {
  if (externalApiKeyId) {
    await request.delete(`${BASE_URL}/api/developer/apikeys/${externalApiKeyId}`, {
      headers: headers(adminToken),
    }).catch(() => {});
  }
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

test('admin imports pickup locations while non-admin import stays forbidden', async ({ request }) => {
  const importedName = `${RUN_TAG} Imported Gate`;
  const [response, forbidden] = await Promise.all([
    request.post(`${BASE_URL}/api/pickup-plot-inventory/locations/import`, {
      headers: headers(adminToken),
      data: { rows: [
        { name: `${RUN_TAG} Main Gate`, address: '11 Updated Test Avenue', maxAssignments: '20', isActive: 'TRUE' },
        { name: importedName, address: '12 Import Avenue', maxAssignments: '', isActive: 'TRUE' },
      ] },
    }),
    request.post(`${BASE_URL}/api/pickup-plot-inventory/locations/import`, {
      headers: headers(userToken),
      data: { rows: [{ name: `${RUN_TAG} Forbidden Import`, address: '99 Test Avenue' }] },
    }),
  ]);
  expect(response.status()).toBe(200);
  expect(await response.json()).toMatchObject({ total: 2, created: 1, updated: 1 });
  expect(forbidden.status()).toBe(403);

  const inventory = await request.get(`${BASE_URL}/api/pickup-plot-inventory`, { headers: headers(adminToken) });
  const body = await inventory.json();
  expect(body.pickupLocations.some((row) => row.name === importedName && row.address === '12 Import Avenue')).toBeTruthy();
  expect(body.pickupLocations.some((row) => row.id === locationId && row.maxAssignments === 20)).toBeTruthy();
});

test('non-admin cannot manage billing persons', async ({ request }) => {
  const response = await request.get(`${BASE_URL}/api/pickup-plot-inventory/billing-persons`, {
    headers: headers(userToken),
  });
  expect(response.status()).toBe(403);
});

test('workspace calling routes validate campaign input and hide unassigned customers', async ({ request }) => {
  const missingContactId = 2147483647;
  const [context, aiCall, manualCall] = await Promise.all([
    request.get(`${BASE_URL}/api/pickup-plot-inventory/calling/customers/${missingContactId}/context`, {
      headers: headers(adminToken),
    }),
    request.post(`${BASE_URL}/api/pickup-plot-inventory/calling/customers/${missingContactId}/ai-call`, {
      headers: headers(adminToken), data: {},
    }),
    request.post(`${BASE_URL}/api/pickup-plot-inventory/calling/customers/${missingContactId}/manual-call`, {
      headers: headers(adminToken), data: {},
    }),
  ]);
  expect(context.status()).toBe(404);
  expect((await context.json()).code).toBe('CALLING_CUSTOMER_NOT_FOUND');
  expect(aiCall.status()).toBe(400);
  expect((await aiCall.json()).code).toBe('MISSING_CAMPAIGN_ID');
  expect(manualCall.status()).toBe(400);
  expect((await manualCall.json()).code).toBe('MISSING_CAMPAIGN_ID');
});

test('staff work assignment directory includes User staff but excludes elevated system roles', async ({ request }) => {
  const [adminResponse, userResponse] = await Promise.all([
    request.get(`${BASE_URL}/api/pickup-plot-inventory/work-assignments`, {
      headers: headers(adminToken),
    }),
    request.get(`${BASE_URL}/api/pickup-plot-inventory/work-assignments`, {
      headers: headers(userToken),
    }),
  ]);
  expect(adminResponse.status()).toBe(200);
  const body = await adminResponse.json();
  expect(body.staff).toEqual(expect.any(Array));
  expect(body.staff.every((person) => !Object.prototype.hasOwnProperty.call(person, 'role'))).toBeTruthy();
  expect(body.staff.some((person) => String(person.email || '').toLowerCase() === 'user@crm.com')).toBeTruthy();
  expect(body.staff.some((person) => ['admin@globussoft.com', 'manager@crm.com']
    .includes(String(person.email || '').toLowerCase()))).toBeFalsy();
  expect(userResponse.status()).toBe(403);
});

test('direct Sales Executive and Billing handoff assignment is admin-only', async ({ request }) => {
  const brokerPath = `${BASE_URL}/api/pickup-plot-inventory/brokers/me/assignments/awaiting-broker-customer-1-plot-1/assign`;
  const billingPath = `${BASE_URL}/api/pickup-plot-inventory/billing/me/assignments/1-1-1/assign`;
  const [adminBroker, adminBilling, userBroker, userBilling] = await Promise.all([
    request.patch(brokerPath, { headers: headers(adminToken), data: { targetProfileId: 0 } }),
    request.patch(billingPath, { headers: headers(adminToken), data: { targetProfileId: 0 } }),
    request.patch(brokerPath, { headers: headers(userToken), data: { targetProfileId: 1 } }),
    request.patch(billingPath, { headers: headers(userToken), data: { targetProfileId: 1 } }),
  ]);
  expect(adminBroker.status()).toBe(400);
  expect(adminBilling.status()).toBe(400);
  expect(userBroker.status()).toBe(403);
  expect(userBilling.status()).toBe(403);
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

test('only an admin can generate or record a plot initial payment', async ({ request }) => {
  const response = await request.post(`${BASE_URL}/api/pickup-plot-inventory/customer-pickups/1/initial-payment`, {
    headers: headers(userToken),
    data: { amount: 1000, method: 'upi', transactionRef: `${RUN_TAG}_FORBIDDEN` },
  });
  expect(response.status()).toBe(403);
});

test('only an admin can create a plot installment schedule', async ({ request }) => {
  const response = await request.post(`${BASE_URL}/api/pickup-plot-inventory/customer-pickups/1/installments`, {
    headers: headers(userToken),
    data: { plotBookingId: 1, frequency: 'MONTHLY', paymentCount: 2, firstMonth: 11, firstYear: 2026, amount: 1000 },
  });
  expect(response.status()).toBe(403);
});

test('only an admin can update a plot commission', async ({ request }) => {
  const [statusResponse, rateResponse] = await Promise.all([
    request.patch(`${BASE_URL}/api/pickup-plot-inventory/commissions/1/status`, {
      headers: headers(userToken),
      data: { status: 'APPROVED' },
    }),
    request.patch(`${BASE_URL}/api/pickup-plot-inventory/commissions/1/rate`, {
      headers: headers(userToken),
      data: { commissionPercent: 5 },
    }),
  ]);
  expect(statusResponse.status()).toBe(403);
  expect(rateResponse.status()).toBe(403);
});

test('multi-plot customer assignment is admin-only and validates the selection', async ({ request }) => {
  const [userResponse, invalidAdminResponse] = await Promise.all([
    request.post(`${BASE_URL}/api/pickup-plot-inventory/customer-pickups/1/plots`, {
      headers: headers(userToken),
      data: { plotSiteIds: [1, 2] },
    }),
    request.post(`${BASE_URL}/api/pickup-plot-inventory/customer-pickups/1/plots`, {
      headers: headers(adminToken),
      data: { plotSiteIds: [] },
    }),
  ]);
  expect(userResponse.status()).toBe(403);
  expect(invalidAdminResponse.status()).toBe(400);
  expect((await invalidAdminResponse.json()).code).toBe('INVALID_PLOT_IDS');
});

test('generic lead users can read only the scoped pickup workflow projection', async ({ request }) => {
  const contactsResponse = await request.get(`${BASE_URL}/api/contacts?status=Lead&limit=1`, {
    headers: headers(adminToken),
  });
  expect(contactsResponse.ok()).toBeTruthy();
  const contactsBody = await contactsResponse.json();
  const contacts = Array.isArray(contactsBody) ? contactsBody : contactsBody.data;
  test.skip(!contacts?.length, 'The seeded generic tenant has no Lead row to project.');

  const contactId = contacts[0].id;
  const [adminResponse, userResponse] = await Promise.all([
    request.get(`${BASE_URL}/api/pickup-plot-inventory/lead-status?contactIds=${contactId}`, {
      headers: headers(adminToken),
    }),
    request.get(`${BASE_URL}/api/pickup-plot-inventory/lead-status?contactIds=${contactId}`, {
      headers: headers(userToken),
    }),
  ]);
  expect(adminResponse.status()).toBe(200);
  expect(await adminResponse.json()).toMatchObject({ customers: expect.any(Array) });
  expect(userResponse.status()).toBe(200);
  expect(await userResponse.json()).toMatchObject({ customers: expect.any(Array) });
});

test('a user without transport workspace permission is denied before profile lookup', async ({ request }) => {
  const [workspaceResponse, scheduleResponse] = await Promise.all([
    request.get(`${BASE_URL}/api/pickup-plot-inventory/transport-persons/me`, {
      headers: headers(userToken),
    }),
    request.patch(`${BASE_URL}/api/pickup-plot-inventory/transport-persons/me/assignments/customer-1-plot-1/schedule`, {
      headers: headers(userToken),
      data: { scheduledDropOffAt: new Date(Date.now() + 86_400_000).toISOString() },
    }),
  ]);
  expect(workspaceResponse.status()).toBe(403);
  expect((await workspaceResponse.json()).code).toBe('RBAC_DENIED');
  expect(scheduleResponse.status()).toBe(403);
  expect((await scheduleResponse.json()).code).toBe('RBAC_DENIED');
});

test('a user without site visit workspace permission is denied before profile lookup', async ({ request }) => {
  const response = await request.get(`${BASE_URL}/api/pickup-plot-inventory/brokers/me`, {
    headers: headers(userToken),
  });
  expect(response.status()).toBe(403);
  expect((await response.json()).code).toBe('RBAC_DENIED');
});

test('a user without site visit update permission cannot advance a workflow', async ({ request }) => {
  const response = await request.patch(`${BASE_URL}/api/pickup-plot-inventory/brokers/me/customers/1/workflow`, {
    headers: headers(userToken),
    data: { status: 'EXPLANATION_STARTED' },
  });
  expect(response.status()).toBe(403);
  expect((await response.json()).code).toBe('RBAC_DENIED');
});

test('a user without billing workspace permission cannot access the billing queue', async ({ request }) => {
  const response = await request.get(`${BASE_URL}/api/pickup-plot-inventory/billing/me`, {
    headers: headers(userToken),
  });
  expect(response.status()).toBe(403);
  expect((await response.json()).code).toBe('RBAC_DENIED');
});

test('an unlinked user cannot read or update another staff work profile', async ({ request }) => {
  const [readResponse, updateResponse] = await Promise.all([
    request.get(`${BASE_URL}/api/pickup-plot-inventory/people/me`, {
      headers: headers(userToken),
    }),
    request.put(`${BASE_URL}/api/pickup-plot-inventory/people/me`, {
      headers: headers(userToken),
      data: { roleType: 'transport', assignments: [] },
    }),
  ]);
  expect(readResponse.status()).toBe(404);
  expect((await readResponse.json()).code).toBe('OPERATIONAL_PROFILE_NOT_LINKED');
  expect(updateResponse.status()).toBe(404);
  expect((await updateResponse.json()).code).toBe('OPERATIONAL_PROFILE_NOT_LINKED');
});

test('admin creates and edits a plot assigned to the pickup location', async ({ request }) => {
  const created = await request.post(`${BASE_URL}/api/pickup-plot-inventory/plots`, {
    headers: headers(adminToken),
    data: {
      name: `${RUN_TAG} Plot A`, plotNumber: 'A-101', block: 'A', address: '25 Lake Road',
      area: '2', areaUnit: 'KATHA', price: 250000, roadWidth: '30 ft', facing: 'EAST',
      propertyType: 'RESIDENTIAL', availability: 'AVAILABLE', isActive: true,
    },
  });
  expect(created.status()).toBe(201);
  plotId = (await created.json()).id;

  const updated = await request.put(`${BASE_URL}/api/pickup-plot-inventory/plots/${plotId}`, {
    headers: headers(adminToken),
    data: {
      name: `${RUN_TAG} Plot A`, plotNumber: 'A-101', block: 'A', address: '26 Lake Road',
      area: '2', areaUnit: 'KATHA', price: 250000, roadWidth: '40 ft', facing: 'EAST',
      propertyType: 'RESIDENTIAL', availability: 'RESERVED', isActive: true,
    },
  });
  expect(updated.status()).toBe(200);
  expect(await updated.json()).toMatchObject({
    plotNumber: 'A-101', block: 'A', area: '2', areaUnit: 'KATHA', roadWidth: '40 ft',
    facing: 'EAST', propertyType: 'RESIDENTIAL', availability: 'RESERVED', address: '26 Lake Road',
  });
});

test('external plot inventory key returns only the safe generic catalog projection', async ({ request }) => {
  const response = await request.get(
    `${BASE_URL}/api/v1/external/plot-inventory?q=${encodeURIComponent(RUN_TAG)}&limit=10`,
    { headers: { 'X-API-Key': externalApiKey } },
  );
  expect(response.status()).toBe(200);
  const body = await response.json();
  expect(body.meta).toMatchObject({ vertical: 'generic' });
  const plot = body.data.find((row) => row.id === plotId);
  expect(plot).toBeTruthy();
  expect(plot).toMatchObject({
    name: `${RUN_TAG} Plot A`,
    plotNumber: 'A-101',
    availability: 'RESERVED',
  });
  expect(plot).not.toHaveProperty('tenantId');
  expect(plot).not.toHaveProperty('notes');
  expect(plot).not.toHaveProperty('boundary');
  expect(plot).not.toHaveProperty('pickupLocationIdsJson');
});

test('inventory key cannot access other external APIs', async ({ request }) => {
  for (const [method, path] of [['get', '/api/v1/external/contacts'], ['post', '/api/v1/external/leads'], ['post', '/api/v1/voyagr/leads']]) {
    const response = await request[method](`${BASE_URL}${path}`, {
      headers: { 'X-API-Key': externalApiKey },
    });
    expect(response.status()).toBe(403);
  }
});

test('external inventory filters plots by secondary numeric pickup location', async ({ request }) => {
  const location = await request.post(`${BASE_URL}/api/pickup-plot-inventory/locations`, {
    headers: headers(adminToken), data: { name: `${RUN_TAG} Secondary Gate`, address: '27 Test Avenue' },
  });
  expect(location.status()).toBe(201);
  const secondaryId = (await location.json()).id;
  const update = await request.put(`${BASE_URL}/api/pickup-plot-inventory/plots/${plotId}`, {
    headers: headers(adminToken),
    data: {
      name: `${RUN_TAG} Plot A`, plotNumber: 'A-101', block: 'A', address: '26 Lake Road',
      area: '2', areaUnit: 'KATHA', price: 250000, roadWidth: '40 ft', facing: 'EAST',
      propertyType: 'RESIDENTIAL', availability: 'RESERVED', isActive: true,
      pickupLocationIds: [locationId, secondaryId],
    },
  });
  expect(update.status()).toBe(200);
  const response = await request.get(`${BASE_URL}/api/v1/external/plot-inventory`, {
    headers: { 'X-API-Key': externalApiKey },
    params: { q: RUN_TAG, pickupLocationId: secondaryId, limit: 1 },
  });
  expect(response.status()).toBe(200);
  const body = await response.json();
  expect(body.total).toBe(1);
  expect(body.hasMore).toBe(false);
  expect(body.data.map((row) => row.id)).toContain(plotId);
});

test('plot creation rejects missing mandatory inventory fields', async ({ request }) => {
  const response = await request.post(`${BASE_URL}/api/pickup-plot-inventory/plots`, {
    headers: headers(adminToken),
    data: {
      name: `${RUN_TAG} Incomplete Plot`, plotNumber: '', block: 'A', address: '25 Lake Road',
      area: '1200', areaUnit: 'SQ_FT', price: 250000, roadWidth: '30 ft',
      propertyType: 'RESIDENTIAL', availability: 'AVAILABLE',
    },
  });
  expect(response.status()).toBe(400);
  expect(await response.json()).toMatchObject({
    error: 'Plot number is required.',
    code: 'VALIDATION_ERROR',
  });
});

test('admin imports CSV/Excel-shaped plot rows and gets row-level validation errors', async ({ request }) => {
  const importedName = `${RUN_TAG} Imported Plot`;
  const response = await request.post(`${BASE_URL}/api/pickup-plot-inventory/plots/import`, {
    headers: headers(adminToken),
    data: { rows: [{
      name: importedName, plotNumber: 'IMP-1', block: 'I', address: '28 Import Road',
      pickupLocationNames: `${RUN_TAG} Main Gate`, area: '1500', areaUnit: 'SQ_FT',
      price: '375000', availability: 'AVAILABLE', roadWidth: '35 ft', facing: 'NORTH',
      propertyType: 'RESIDENTIAL', isActive: 'TRUE',
    }] },
  });
  expect(response.status()).toBe(200);
  expect(await response.json()).toMatchObject({ total: 1, created: 1, updated: 0 });

  const invalid = await request.post(`${BASE_URL}/api/pickup-plot-inventory/plots/import`, {
    headers: headers(adminToken),
    data: { rows: [{
      name: `${RUN_TAG} Bad Import`, plotNumber: 'BAD-1', block: 'B', address: '29 Import Road',
      pickupLocationNames: 'Location that does not exist', area: '1000', areaUnit: 'SQ_FT',
      price: '100000', availability: 'AVAILABLE', roadWidth: '20 ft',
      propertyType: 'RESIDENTIAL', isActive: 'TRUE',
    }] },
  });
  expect(invalid.status()).toBe(400);
  expect(await invalid.json()).toMatchObject({
    code: 'IMPORT_VALIDATION_ERROR',
    errors: [{ row: 2, error: 'Pickup location "Location that does not exist" was not found.' }],
  });

  const inventory = await request.get(`${BASE_URL}/api/pickup-plot-inventory`, { headers: headers(adminToken) });
  expect((await inventory.json()).plots.some((row) => row.name === importedName && row.plotNumber === 'IMP-1')).toBeTruthy();
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

test('transport person creation requires vehicle details', async ({ request }) => {
  const response = await request.post(`${BASE_URL}/api/pickup-plot-inventory/transport-persons`, {
    headers: headers(adminToken),
    data: {
      name: `${RUN_TAG.replace(/[^a-z]/gi, 'a')} Driver`, phone: '9000011111',
      vehicleType: '', vehicleNumber: 'KA 01 AB 1234',
    },
  });
  expect(response.status()).toBe(400);
  expect(await response.json()).toMatchObject({
    error: 'Vehicle type is required.',
    code: 'VALIDATION_ERROR',
  });
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

test('people directories retain tenant-scoped legacy profiles without staff logins', async ({ request }) => {
  const [transportResponse, brokerResponse] = await Promise.all([
    request.get(`${BASE_URL}/api/pickup-plot-inventory/transport-persons`, { headers: headers(adminToken) }),
    request.get(`${BASE_URL}/api/pickup-plot-inventory/brokers`, { headers: headers(adminToken) }),
  ]);
  expect(transportResponse.status()).toBe(200);
  expect(brokerResponse.status()).toBe(200);
  expect((await transportResponse.json()).transportPersons).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: transportPersonId, userId: null }),
  ]));
  expect((await brokerResponse.json()).brokers).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: brokerId, userId: null }),
  ]));
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
