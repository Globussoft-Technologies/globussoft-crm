// @ts-check
const { test, expect } = require('@playwright/test');

test.describe.configure({ mode: 'serial' });

const BASE_URL = process.env.BASE_URL || 'http://localhost:5000';
const RUN_TAG = `E2E_SALES_TEAM_${Date.now()}_${process.pid}`;
let adminToken;
let userToken;
let teamId;

async function login(request, email) {
  const response = await request.post(`${BASE_URL}/api/auth/login`, {
    data: { email, password: 'password123' },
  });
  expect(response.ok(), await response.text()).toBeTruthy();
  return (await response.json()).token;
}

const headers = (token) => ({ Authorization: `Bearer ${token}` });

test.beforeAll(async ({ request }) => {
  adminToken = await login(request, 'admin@globussoft.com');
  userToken = await login(request, 'user@crm.com');
});

test.afterAll(async ({ request }) => {
  if (teamId && adminToken) {
    await request.delete(`${BASE_URL}/api/sales-teams/${teamId}`, { headers: headers(adminToken) });
  }
});

test('regular users cannot read or mutate sales teams', async ({ request }) => {
  const list = await request.get(`${BASE_URL}/api/sales-teams`, { headers: headers(userToken) });
  expect(list.status()).toBe(403);
  expect((await list.json()).code).toBe('RBAC_DENIED');

  const create = await request.post(`${BASE_URL}/api/sales-teams`, {
    headers: headers(userToken), data: { name: RUN_TAG, memberIds: [] },
  });
  expect(create.status()).toBe(403);
});

test('admin can create, list, update, and delete a tenant-owned team', async ({ request }) => {
  const created = await request.post(`${BASE_URL}/api/sales-teams`, {
    headers: headers(adminToken), data: { name: RUN_TAG, memberIds: [] },
  });
  expect(created.status(), await created.text()).toBe(201);
  const body = await created.json();
  teamId = body.id;

  const listed = await request.get(`${BASE_URL}/api/sales-teams`, { headers: headers(adminToken) });
  expect(listed.ok()).toBeTruthy();
  expect((await listed.json()).some((team) => team.id === teamId && team.name === RUN_TAG)).toBe(true);

  const updated = await request.put(`${BASE_URL}/api/sales-teams/${teamId}`, {
    headers: headers(adminToken), data: { name: `${RUN_TAG}_UPDATED`, memberIds: [] },
  });
  expect(updated.ok(), await updated.text()).toBeTruthy();
  expect((await updated.json()).name).toBe(`${RUN_TAG}_UPDATED`);

  const removed = await request.delete(`${BASE_URL}/api/sales-teams/${teamId}`, { headers: headers(adminToken) });
  expect(removed.ok()).toBeTruthy();
  teamId = null;
});

test('tenant-scoped mutation returns 404 for an inaccessible id', async ({ request }) => {
  const response = await request.put(`${BASE_URL}/api/sales-teams/2147483647`, {
    headers: headers(adminToken), data: { name: RUN_TAG },
  });
  expect(response.status()).toBe(404);
  expect((await response.json()).code).toBe('TEAM_NOT_FOUND');
});
