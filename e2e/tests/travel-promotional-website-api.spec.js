// @ts-check
/**
 * Travel promotional website settings API.
 *
 * This spec deliberately exercises validation and masking only. It never
 * writes real customer hosting credentials or opens an SFTP connection; the
 * network publisher is covered with an injected client in backend unit tests.
 */
const { test, expect } = require('@playwright/test');

const BASE_URL = process.env.BASE_URL || 'https://crm.globusdemos.com';
const REQUEST_TIMEOUT = 60000;
let travelToken = null;
let genericToken = null;

async function login(request, email) {
  const response = await request.post(`${BASE_URL}/api/auth/login`, {
    data: { email, password: 'password123' },
    headers: { 'Content-Type': 'application/json' },
    timeout: REQUEST_TIMEOUT,
  });
  if (!response.ok()) return null;
  return (await response.json()).token || null;
}

const headers = (token) => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' });

test.describe('Travel promotional website settings', () => {
  test.beforeAll(async ({ request }) => {
    travelToken = await login(request, 'yasin@travelstall.in');
    genericToken = await login(request, 'admin@globussoft.com');
  });

  test('requires authentication', async ({ request }) => {
    const response = await request.get(`${BASE_URL}/api/travel/promotional-website`, { timeout: REQUEST_TIMEOUT });
    expect(response.status()).toBe(401);
  });

  test('customer-hosted landing forms receive a scoped CORS preflight', async ({ request }) => {
    const origin = 'https://customer.example.com';
    const response = await request.fetch(`${BASE_URL}/api/pages/travel-offer/submit`, {
      method: 'OPTIONS',
      headers: {
        Origin: origin,
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'content-type',
      },
      timeout: REQUEST_TIMEOUT,
    });
    expect(response.status()).toBe(204);
    expect(response.headers()['access-control-allow-origin']).toBe(origin);
  });

  test('travel admin can read masked hosting settings', async ({ request }) => {
    test.skip(!travelToken, 'travel admin is not seeded in this environment');
    const response = await request.get(`${BASE_URL}/api/travel/promotional-website`, {
      headers: headers(travelToken),
      timeout: REQUEST_TIMEOUT,
    });
    expect(response.status()).toBe(200);
    const body = await response.json();
    expect(typeof body.websiteUrl).toBe('string');
    expect(body.sftp?.password).toBeUndefined();
    expect(body.sftp?.privateKey).toBeUndefined();
  });

  test('rejects invalid website URLs without writing credentials', async ({ request }) => {
    test.skip(!travelToken, 'travel admin is not seeded in this environment');
    const response = await request.put(`${BASE_URL}/api/travel/promotional-website`, {
      headers: headers(travelToken),
      data: { websiteUrl: 'javascript:alert(1)', sftp: {} },
      timeout: REQUEST_TIMEOUT,
    });
    expect(response.status()).toBe(400);
    expect((await response.json()).code).toBe('INVALID_PROMOTIONAL_WEBSITE_SETTINGS');
  });

  test('rejects a non-travel admin', async ({ request }) => {
    test.skip(!genericToken, 'generic admin is not seeded in this environment');
    const response = await request.get(`${BASE_URL}/api/travel/promotional-website`, {
      headers: headers(genericToken),
      timeout: REQUEST_TIMEOUT,
    });
    expect(response.status()).toBe(403);
    expect((await response.json()).code).toBe('TRAVEL_ONLY');
  });
});
