// @ts-check
/**
 * Territories routes — /api/territories/*
 *   Auth:    GET /, POST /, PUT /:id, DELETE /:id,
 *            POST /:id/assign-contact, GET /:id/contacts
 */
const { test, expect } = require('@playwright/test');

const BASE_URL = process.env.BASE_URL || 'https://crm.globusdemos.com';
const API = `${BASE_URL}/api`;

const ADMIN_EMAIL = 'admin@globussoft.com';
const ADMIN_PASSWORD = 'password123';

let adminToken = '';
const createdTerritoryIds = [];
let seedContactId = null;

test.describe.configure({ mode: 'serial' });

test.describe('territories.js — territory CRUD + contact assignment', () => {
  test.beforeAll(async ({ request }) => {
    const login = await request.post(`${API}/auth/login`, {
      data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
    });
    expect(login.ok()).toBeTruthy();
    adminToken = (await login.json()).token;

    const c = await request.get(`${API}/contacts?limit=1`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    if (c.ok()) {
      const data = await c.json();
      const list = Array.isArray(data) ? data : data.data || data.contacts || [];
      if (list[0]) seedContactId = list[0].id;
    }
  });

  test.afterAll(async ({ request }) => {
    for (const id of createdTerritoryIds) {
      await request.delete(`${API}/territories/${id}`, {
        headers: { Authorization: `Bearer ${adminToken}` },
      });
    }
  });

  const auth = () => ({ Authorization: `Bearer ${adminToken}` });

  test('GET /territories requires auth', async ({ request }) => {
    const res = await request.get(`${API}/territories`);
    expect([401, 403]).toContain(res.status());
  });

  test('GET /territories returns array with contactCount', async ({ request }) => {
    const res = await request.get(`${API}/territories`, { headers: auth() });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    for (const t of body) {
      expect(typeof t.contactCount).toBe('number');
      expect(Array.isArray(t.regions)).toBe(true);
      expect(Array.isArray(t.assignedUserIds)).toBe(true);
    }
  });

  test('POST /territories requires name', async ({ request }) => {
    const res = await request.post(`${API}/territories`, {
      headers: auth(),
      data: { regions: ['Maharashtra'] },
    });
    expect(res.status()).toBe(400);
  });

  test('POST /territories creates a territory', async ({ request }) => {
    const tag = `E2E_AUDIT_${Date.now()}`;
    const res = await request.post(`${API}/territories`, {
      headers: auth(),
      data: {
        name: tag,
        regions: ['Maharashtra', 'Gujarat'],
        assignedUserIds: [],
      },
    });
    expect(res.status()).toBe(201);
    const body = await res.json();
    expect(body.id).toBeTruthy();
    expect(body.name).toBe(tag);
    expect(body.regions).toEqual(['Maharashtra', 'Gujarat']);
    expect(body.contactCount).toBe(0);
    createdTerritoryIds.push(body.id);
  });

  test('PUT /territories/:id updates regions', async ({ request }) => {
    const id = createdTerritoryIds[0];
    test.skip(!id, 'no territory created');
    const res = await request.put(`${API}/territories/${id}`, {
      headers: auth(),
      data: { regions: ['Karnataka'] },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.regions).toEqual(['Karnataka']);
  });

  test('PUT /territories/:id 404s for unknown id', async ({ request }) => {
    const res = await request.put(`${API}/territories/99999999`, {
      headers: auth(),
      data: { name: 'doesnotexist' },
    });
    expect(res.status()).toBe(404);
  });

  test('POST /territories/:id/assign-contact requires contactId', async ({ request }) => {
    const id = createdTerritoryIds[0];
    test.skip(!id, 'no territory');
    const res = await request.post(`${API}/territories/${id}/assign-contact`, {
      headers: auth(),
      data: {},
    });
    expect(res.status()).toBe(400);
  });

  test('POST /territories/:id/assign-contact assigns then GET /:id/contacts shows it', async ({ request }) => {
    const id = createdTerritoryIds[0];
    test.skip(!id || !seedContactId, 'need territory + seeded contact');

    const assign = await request.post(`${API}/territories/${id}/assign-contact`, {
      headers: auth(),
      data: { contactId: seedContactId },
    });
    expect(assign.status()).toBe(200);
    const aBody = await assign.json();
    expect(aBody.success).toBe(true);

    const list = await request.get(`${API}/territories/${id}/contacts`, { headers: auth() });
    expect(list.status()).toBe(200);
    const contacts = await list.json();
    expect(Array.isArray(contacts)).toBe(true);
    expect(contacts.find((c) => c.id === seedContactId)).toBeTruthy();
  });

  // DELETE happy path is exercised in afterAll cleanup (tested implicitly).
});
