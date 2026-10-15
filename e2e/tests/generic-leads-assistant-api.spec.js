// Generic CRM Leads assistant API contract. These checks intentionally avoid
// provider spend: they pin auth, vertical isolation, and request validation.
const { test, expect } = require('@playwright/test');

const BASE_URL = process.env.BASE_URL || 'https://crm.globusdemos.com';

async function loginAs(request, email, password) {
  const response = await request.post(`${BASE_URL}/api/auth/login`, {
    data: { email, password },
    headers: { 'Content-Type': 'application/json' },
  });
  if (!response.ok()) return null;
  return (await response.json()).token;
}

test('Leads assistant requires authentication', async ({ request }) => {
  const response = await request.post(`${BASE_URL}/api/leads-assistant/message`, {
    data: { message: 'show my leads' },
  });
  expect(response.status()).toBe(401);
});

test('Leads assistant validates the message envelope for Generic CRM', async ({ request }) => {
  const token = await loginAs(request, 'admin@globussoft.com', 'password123');
  test.skip(!token, 'Generic CRM demo credentials are unavailable in this environment');
  const response = await request.post(`${BASE_URL}/api/leads-assistant/message`, {
    headers: { Authorization: `Bearer ${token}` },
    data: { message: '  ' },
  });
  expect(response.status()).toBe(400);
  expect((await response.json()).code).toBe('MISSING_MESSAGE');
});

test('Leads assistant is isolated from Wellness tenants', async ({ request }) => {
  const token = await loginAs(request, 'admin@wellness.demo', 'password123');
  test.skip(!token, 'Wellness demo credentials are unavailable in this environment');
  const response = await request.post(`${BASE_URL}/api/leads-assistant/message`, {
    headers: { Authorization: `Bearer ${token}` },
    data: { message: 'show my leads' },
  });
  expect(response.status()).toBe(403);
  expect((await response.json()).code).toBe('GENERIC_TENANT_REQUIRED');
});
