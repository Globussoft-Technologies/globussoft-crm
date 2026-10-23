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

test.describe('Generic CRM Google Maps settings', () => {
  test('generic admin reads masked status without receiving a credential', async ({ request }) => {
    const token = await login(request, 'admin@globussoft.com');
    const response = await request.get(`${BASE_URL}/api/settings/google-maps`, { headers: auth(token) });
    expect(response.status()).toBe(200);
    const body = await response.json();
    expect(typeof body.enabled).toBe('boolean');
    expect(typeof body.configured).toBe('boolean');
    expect(['tenant', 'backend', 'none']).toContain(body.source);
    expect(body.apiKey).toBeUndefined();
    expect(body.effectiveKey).toBeUndefined();
  });

  test('wellness tenant cannot access generic Google Maps settings', async ({ request }) => {
    const token = await login(request, 'admin@wellness.demo');
    const response = await request.get(`${BASE_URL}/api/settings/google-maps`, { headers: auth(token) });
    expect(response.status()).toBe(403);
    expect((await response.json()).code).toBe('WRONG_VERTICAL');
  });
});
