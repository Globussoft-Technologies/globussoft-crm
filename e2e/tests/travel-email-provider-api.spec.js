// @ts-check
const { test, expect } = require('@playwright/test');

const BASE_URL = process.env.BASE_URL || 'https://crm.globusdemos.com';

async function login(request, email) {
  const response = await request.post(`${BASE_URL}/api/auth/login`, {
    data: { email, password: 'password123' },
  });
  expect(response.ok()).toBeTruthy();
  return (await response.json()).token;
}

const auth = (token) => ({ Authorization: `Bearer ${token}` });

test('Travel admin can inspect SendGrid BYOK status without receiving a secret', async ({ request }) => {
  const token = await login(request, 'yasin@travelstall.in');
  const response = await request.get(`${BASE_URL}/api/travel/email-provider`, { headers: auth(token) });
  expect(response.status()).toBe(200);
  const body = await response.json();
  expect(typeof body.configured).toBe('boolean');
  expect(['tenant', 'backend']).toContain(body.source);
  expect(body.apiKey).toBeUndefined();
  expect(JSON.stringify(body)).not.toContain('SG.');
});

test('Generic tenant cannot access Travel SendGrid BYOK settings', async ({ request }) => {
  const token = await login(request, 'admin@globussoft.com');
  const response = await request.get(`${BASE_URL}/api/travel/email-provider`, { headers: auth(token) });
  expect(response.status()).toBe(403);
});
