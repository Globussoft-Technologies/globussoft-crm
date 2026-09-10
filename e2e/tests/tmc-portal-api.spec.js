// @ts-check
const { test, expect } = require('@playwright/test');

test.describe.configure({ mode: 'serial' });

const BASE_URL = process.env.BASE_URL || 'https://crm.globusdemos.com';
const REQUEST_TIMEOUT = 60000;

async function login(request, email) {
  const res = await request.post(`${BASE_URL}/api/auth/login`, {
    data: { email, password: 'password123' },
    timeout: REQUEST_TIMEOUT,
  });
  expect(res.status(), `login ${email}: ${await res.text()}`).toBe(200);
  return (await res.json()).token;
}

test.describe('TMC portal API security contract', () => {
  test('teacher portal rejects requests without a portal token', async ({ request }) => {
    const res = await request.get(`${BASE_URL}/api/portal/tmc/teacher/me`, {
      timeout: REQUEST_TIMEOUT,
    });
    expect(res.status()).toBe(401);
    expect(await res.json()).toMatchObject({ code: 'PORTAL_TOKEN_REQUIRED' });
  });

  test('a staff JWT cannot be substituted for a contact portal JWT', async ({ request }) => {
    const token = await login(request, 'yasin@travelstall.in');
    const res = await request.get(`${BASE_URL}/api/portal/tmc/teacher/me`, {
      headers: { Authorization: `Bearer ${token}` },
      timeout: REQUEST_TIMEOUT,
    });
    expect(res.status()).toBe(401);
    expect(await res.json()).toMatchObject({ code: 'INVALID_PORTAL_TOKEN' });
  });

  test('generic-tenant staff cannot access the travel-only teacher directory', async ({ request }) => {
    const token = await login(request, 'admin@globussoft.com');
    const res = await request.get(`${BASE_URL}/api/portal/tmc/staff/teachers`, {
      headers: { Authorization: `Bearer ${token}` },
      timeout: REQUEST_TIMEOUT,
    });
    expect(res.status()).toBe(403);
  });

  test('travel admin can list only the tenant-scoped TMC teacher directory', async ({ request }) => {
    const token = await login(request, 'yasin@travelstall.in');
    const res = await request.get(`${BASE_URL}/api/portal/tmc/staff/teachers`, {
      headers: { Authorization: `Bearer ${token}` },
      timeout: REQUEST_TIMEOUT,
    });
    expect(res.status(), await res.text()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.teachers)).toBe(true);
    for (const teacher of body.teachers) {
      expect(teacher).toEqual(expect.objectContaining({ id: expect.any(Number) }));
      expect(teacher).not.toHaveProperty('portalPasswordHash');
      expect(teacher).not.toHaveProperty('tenantId');
    }
  });
});
