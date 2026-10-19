const { test, expect } = require('@playwright/test');
const API = `${process.env.BASE_URL || 'http://localhost:5000'}/api`;
test.describe('Zapier release-one setup API', () => {
  let token;
  test.beforeAll(async ({ request }) => {
    const login = await request.post(`${API}/auth/login`, { data: { email: 'admin@globussoft.com', password: 'password123' } });
    expect(login.ok()).toBeTruthy(); token = (await login.json()).token;
  });
  test('requires a staff login for status', async ({ request }) => {
    expect((await request.get(`${API}/zapier/connection`)).status()).toBe(401);
  });
  test('returns an honest scoped connection status', async ({ request }) => {
    const res = await request.get(`${API}/zapier/connection`, { headers: { Authorization: `Bearer ${token}` } });
    expect(res.ok()).toBeTruthy();
    expect(await res.json()).toMatchObject({ configured: expect.any(Number), deliveries: expect.any(Array) });
  });
  test('blocks arbitrary webhook targets without sending anything', async ({ request }) => {
    const res = await request.post(`${API}/zapier/subscribe`, { headers: { Authorization: `Bearer ${token}` }, data: { event: 'contact.created', targetUrl: 'http://127.0.0.1/private' } });
    expect(res.status()).toBe(400);
    expect((await res.json()).code).toBe('INVALID_CATCH_HOOK');
  });
});
