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

test('Generic admin can inspect SendGrid status without receiving a secret', async ({ request }) => {
  const token = await login(request, 'admin@globussoft.com');
  const response = await request.get(`${BASE_URL}/api/generic/email-provider`, { headers: auth(token) });
  expect(response.status()).toBe(200);
  const body = await response.json();
  expect(typeof body.configured).toBe('boolean');
  expect(['tenant', 'backend']).toContain(body.source);
  expect(body.apiKey).toBeUndefined();
  expect(JSON.stringify(body)).not.toContain('SG.');
});

test('Wellness tenant cannot access Generic SendGrid settings', async ({ request }) => {
  const token = await login(request, 'admin@wellness.demo');
  const response = await request.get(`${BASE_URL}/api/generic/email-provider`, { headers: auth(token) });
  expect(response.status()).toBe(403);
  expect((await response.json()).code).toBe('GENERIC_ONLY');
});

test('Generic non-admin cannot replace SendGrid credentials', async ({ request }) => {
  const token = await login(request, 'user@crm.com');
  const statusResponse = await request.get(`${BASE_URL}/api/generic/email-provider`, { headers: auth(token) });
  expect(statusResponse.status()).toBe(200);
  const status = await statusResponse.json();
  expect(status.fromEmail).toMatch(/^[^\s@]+@[^\s@]+\.[^\s@]+$/);
  expect(status.apiKey).toBeUndefined();
  expect(status.apiKeyLast4).toBeUndefined();

  const response = await request.put(`${BASE_URL}/api/generic/email-provider`, {
    headers: { ...auth(token), 'Content-Type': 'application/json' },
    data: { apiKey: 'SG.invalid.forbidden', fromEmail: 'sender@example.test', fromName: 'Forbidden' },
  });
  expect(response.status()).toBe(403);
});
