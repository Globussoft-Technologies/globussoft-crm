// @ts-check
const { test, expect } = require('@playwright/test');

test.describe.configure({ mode: 'serial' });

const BASE_URL = process.env.BASE_URL || 'https://crm.globusdemos.com';

async function login(request, email) {
  const response = await request.post(`${BASE_URL}/api/auth/login`, {
    data: { email, password: 'password123' },
  });
  expect(response.ok()).toBeTruthy();
  return (await response.json()).token;
}

const auth = (token) => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' });

test('Travel admin can list meeting forms and eligible hosts', async ({ request }) => {
  const token = await login(request, 'yasin@travelstall.in');
  const forms = await request.get(`${BASE_URL}/api/travel/meeting-forms`, { headers: auth(token) });
  expect(forms.status()).toBe(200);
  expect(Array.isArray(await forms.json())).toBeTruthy();

  const hosts = await request.get(`${BASE_URL}/api/travel/meeting-forms/hosts`, { headers: auth(token) });
  expect(hosts.status()).toBe(200);
  const rows = await hosts.json();
  expect(Array.isArray(rows)).toBeTruthy();
  expect(rows.every((row) => Array.isArray(row.calendarIntegrations))).toBeTruthy();

  const zoom = await request.get(`${BASE_URL}/api/travel/meeting-forms/zoom-config`, { headers: auth(token) });
  expect(zoom.status()).toBe(200);
  const zoomStatus = await zoom.json();
  expect(typeof zoomStatus.configured).toBe('boolean');
  expect(zoomStatus.clientSecret).toBeUndefined();
  expect(zoomStatus.clientSecretEncrypted).toBeUndefined();
});

test('Generic CRM tenant cannot access Travel Meeting Forms', async ({ request }) => {
  const token = await login(request, 'admin@globussoft.com');
  const response = await request.get(`${BASE_URL}/api/travel/meeting-forms`, { headers: auth(token) });
  expect(response.status()).toBe(403);
});

test('Create validation rejects an invalid host without writing a form', async ({ request }) => {
  const token = await login(request, 'yasin@travelstall.in');
  const response = await request.post(`${BASE_URL}/api/travel/meeting-forms`, {
    headers: auth(token),
    data: { name: 'Invalid host probe', hostUserId: 2147483647, timezone: 'Asia/Kolkata' },
  });
  expect(response.status()).toBe(400);
  expect((await response.json()).code).toBe('INVALID_HOST');
});

test('Create validation rejects an enabled Select field without options', async ({ request }) => {
  const token = await login(request, 'yasin@travelstall.in');
  const hostsResponse = await request.get(`${BASE_URL}/api/travel/meeting-forms/hosts`, { headers: auth(token) });
  expect(hostsResponse.status()).toBe(200);
  const hosts = await hostsResponse.json();
  test.skip(!hosts[0], 'Travel tenant has no eligible staff host');

  const response = await request.post(`${BASE_URL}/api/travel/meeting-forms`, {
    headers: auth(token),
    data: {
      name: 'Invalid select options probe',
      hostUserId: hosts[0].id,
      timezone: 'Asia/Kolkata',
      fields: [{ key: 'custom_choice', label: 'Choose one', type: 'select', enabled: true, options: [] }],
    },
  });
  expect(response.status()).toBe(400);
  expect((await response.json()).code).toBe('SELECT_OPTIONS_REQUIRED');
});

test('Unknown public form does not disclose tenant data', async ({ request }) => {
  const response = await request.get(`${BASE_URL}/api/travel/meeting-forms/public/tmcmf_not_a_real_form`);
  expect(response.status()).toBe(404);
  expect((await response.json()).code).toBe('NOT_FOUND');
});
