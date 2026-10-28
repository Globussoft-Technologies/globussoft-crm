const { test, expect } = require('@playwright/test');

const baseURL = process.env.BASE_URL || 'https://crm.globusdemos.com';
let headers;

test.beforeAll(async ({ request }) => {
  const response = await request.post(`${baseURL}/api/auth/login`, {
    data: { email: 'admin@globussoft.com', password: 'password123' },
  });
  expect(response.status()).toBe(200);
  headers = { Authorization: `Bearer ${(await response.json()).token}` };
});

test('Generic templates return a bounded channel-scoped pagination envelope', async ({ request }) => {
  const response = await request.get(`${baseURL}/api/email-templates?paginate=1&page=1&limit=2&channel=EMAIL`, { headers });
  expect(response.status()).toBe(200);
  const result = await response.json();
  expect(result.items.length).toBeLessThanOrEqual(2);
  expect(result.items.every(item => item.channel === 'EMAIL')).toBe(true);
  expect(result.pagination).toMatchObject({ page: 1, pageSize: 2 });
  expect(result.pagination.total).toBeGreaterThanOrEqual(result.items.length);
});

test('Generic preview resolves missing merge values consistently', async ({ request }) => {
  const response = await request.post(`${baseURL}/api/email-templates/preview`, {
    headers, data: { subject: '{{unknown}}', body: '<p>{{unknown}}</p>' },
  });
  expect(response.status()).toBe(200);
  expect(await response.json()).toMatchObject({ subject: 'the requested information', body: '<p>the requested information</p>' });
});

test('Generic template reorder validates the bounded unique-ID contract', async ({ request }) => {
  const response = await request.put(`${baseURL}/api/email-templates/reorder`, {
    headers,
    data: { channel: 'EMAIL', orderedIds: [1] },
  });
  expect(response.status()).toBe(400);
  expect(await response.json()).toMatchObject({ code: 'INVALID_ORDER' });
});

test('Campaign pagination validates dates and returns scoped totals', async ({ request }) => {
  const invalid = await request.get(`${baseURL}/api/marketing/campaigns?paginate=1&createdFrom=invalid`, { headers });
  expect(invalid.status()).toBe(400);
  const response = await request.get(`${baseURL}/api/marketing/campaigns?paginate=1&limit=2&campaignType=EMAIL&createdFrom=2000-01-01&createdTo=2001-01-01`, { headers });
  expect(response.status()).toBe(200);
  const result = await response.json();
  expect(result.items.length).toBeLessThanOrEqual(2);
  expect(result.items.every(item => item.channel === 'EMAIL' && new Date(item.createdAt) >= new Date('2000-01-01') && new Date(item.createdAt) <= new Date('2001-01-01'))).toBe(true);
  expect(result.pagination).toMatchObject({ page: 1, pageSize: 2 });
});
