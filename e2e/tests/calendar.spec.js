// @ts-check
/**
 * Calendar core route smoke (`/api/calendar`)
 *  - GET /events       (per-user calendar events)
 *  - GET /integrations (per-user provider integrations)
 *  - GET /upcoming     (events from now onward, capped at 10)
 *
 * The endpoints are scoped to the calling user, so an empty array is a
 * perfectly valid response. We assert auth gating + array shape.
 */
const { test, expect } = require('@playwright/test');

const BASE_URL = process.env.BASE_URL || 'https://crm.globusdemos.com';
const API = `${BASE_URL}/api`;

const ADMIN_EMAIL = 'admin@globussoft.com';
const ADMIN_PASSWORD = 'password123';

let adminToken = '';

test.describe.configure({ mode: 'serial' });

test.describe('Calendar core — /api/calendar', () => {
  test.beforeAll(async ({ request }) => {
    const login = await request.post(`${API}/auth/login`, {
      data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
    });
    expect(login.ok(), 'admin login must succeed').toBeTruthy();
    const body = await login.json();
    adminToken = body.token;
  });

  const auth = () => ({ Authorization: `Bearer ${adminToken}` });

  test('auth gate — GET /events without token returns 401/403', async ({ request }) => {
    const res = await request.get(`${API}/calendar/events`);
    expect([401, 403]).toContain(res.status());
  });

  test('GET /events returns array', async ({ request }) => {
    const res = await request.get(`${API}/calendar/events`, { headers: auth() });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
  });

  test('GET /events honours limit query param (smoke — does not exceed)', async ({ request }) => {
    const res = await request.get(`${API}/calendar/events?limit=5`, { headers: auth() });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBeLessThanOrEqual(5);
  });

  test('GET /integrations returns array', async ({ request }) => {
    const res = await request.get(`${API}/calendar/integrations`, { headers: auth() });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    for (const intg of body) {
      expect(typeof intg.id).toBe('number');
      expect(typeof intg.provider).toBe('string');
    }
  });

  test('GET /upcoming returns at most 10 future events', async ({ request }) => {
    const res = await request.get(`${API}/calendar/upcoming`, { headers: auth() });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBeLessThanOrEqual(10);
    const now = Date.now();
    for (const ev of body) {
      expect(new Date(ev.startTime).getTime()).toBeGreaterThanOrEqual(now - 60_000);
    }
  });
});
