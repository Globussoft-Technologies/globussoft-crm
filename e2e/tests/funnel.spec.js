// @ts-check
/**
 * /api/funnel — smoke spec covering 5 read-only handlers in
 * backend/routes/funnel.js. All driven by deal data.
 *
 *   GET    /stages
 *   GET    /conversion-by-source
 *   GET    /by-rep
 *   GET    /velocity
 *   GET    /trend?months=
 */
const { test, expect } = require('@playwright/test');

const BASE_URL = process.env.BASE_URL || 'https://crm.globusdemos.com';
const API = `${BASE_URL}/api`;
const EMAIL = 'admin@globussoft.com';
const PASSWORD = 'password123';

let token = '';
const auth = () => ({ Authorization: `Bearer ${token}` });

test.describe.configure({ mode: 'serial' });

test.describe('funnel API smoke', () => {
  test.beforeAll(async ({ request }) => {
    const login = await request.post(`${API}/auth/login`, {
      data: { email: EMAIL, password: PASSWORD },
    });
    expect(login.ok(), 'admin login must succeed').toBeTruthy();
    token = (await login.json()).token;
  });

  test('GET /stages requires auth', async ({ request }) => {
    const res = await request.get(`${API}/funnel/stages`);
    expect([401, 403]).toContain(res.status());
  });

  test('GET /stages returns { stages: [...] }', async ({ request }) => {
    const res = await request.get(`${API}/funnel/stages`, { headers: auth() });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.stages)).toBe(true);
    if (body.stages.length) {
      const s = body.stages[0];
      expect(s).toHaveProperty('name');
      expect(s).toHaveProperty('current');
      expect(s).toHaveProperty('totalEntered');
      expect(s).toHaveProperty('avgDays');
      expect(s).toHaveProperty('totalValue');
    }
  });

  test('GET /stages honors from/to date filters', async ({ request }) => {
    const res = await request.get(
      `${API}/funnel/stages?from=2020-01-01&to=2099-12-31`,
      { headers: auth() }
    );
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.stages)).toBe(true);
  });

  test('GET /conversion-by-source returns array', async ({ request }) => {
    const res = await request.get(`${API}/funnel/conversion-by-source`, { headers: auth() });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    if (body.length) {
      expect(body[0]).toHaveProperty('source');
      expect(body[0]).toHaveProperty('count');
      expect(body[0]).toHaveProperty('won');
      expect(body[0]).toHaveProperty('conversionRate');
    }
  });

  test('GET /by-rep returns per-owner breakdown', async ({ request }) => {
    const res = await request.get(`${API}/funnel/by-rep`, { headers: auth() });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    if (body.length) {
      const r = body[0];
      expect(r).toHaveProperty('ownerId');
      expect(r).toHaveProperty('owner');
      expect(r).toHaveProperty('total');
      expect(r).toHaveProperty('won');
      expect(r).toHaveProperty('lost');
      expect(r).toHaveProperty('open');
      expect(r).toHaveProperty('winRate');
    }
  });

  test('GET /velocity returns avgDaysInStage per stage', async ({ request }) => {
    const res = await request.get(`${API}/funnel/velocity`, { headers: auth() });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    if (body.length) {
      expect(body[0]).toHaveProperty('stage');
      expect(body[0]).toHaveProperty('avgDaysInStage');
    }
  });

  test('GET /trend returns N month buckets', async ({ request }) => {
    const res = await request.get(`${API}/funnel/trend?months=6`, { headers: auth() });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBe(6);
    expect(body[0]).toHaveProperty('month');
  });

  test('GET /trend clamps months to [1, 36]', async ({ request }) => {
    const res = await request.get(`${API}/funnel/trend?months=999`, { headers: auth() });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.length).toBeLessThanOrEqual(36);
  });
});
