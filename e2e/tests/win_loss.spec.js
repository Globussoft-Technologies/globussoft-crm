// @ts-check
/**
 * Win/Loss routes — /api/win-loss/*
 *   Auth:    GET /reasons, POST /reasons, DELETE /reasons/:id,
 *            GET /analysis, PUT /deals/:dealId/reason
 */
const { test, expect } = require('@playwright/test');

const BASE_URL = process.env.BASE_URL || 'https://crm.globusdemos.com';
const API = `${BASE_URL}/api`;

const ADMIN_EMAIL = 'admin@globussoft.com';
const ADMIN_PASSWORD = 'password123';

let adminToken = '';
const createdReasonIds = [];

test.describe.configure({ mode: 'serial' });

test.describe('win_loss.js — won/lost reasons + analysis', () => {
  test.beforeAll(async ({ request }) => {
    const login = await request.post(`${API}/auth/login`, {
      data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
    });
    expect(login.ok()).toBeTruthy();
    adminToken = (await login.json()).token;
  });

  test.afterAll(async ({ request }) => {
    for (const id of createdReasonIds) {
      await request.delete(`${API}/win-loss/reasons/${id}`, {
        headers: { Authorization: `Bearer ${adminToken}` },
      });
    }
  });

  const auth = () => ({ Authorization: `Bearer ${adminToken}` });

  test('GET /win-loss/reasons requires auth', async ({ request }) => {
    const res = await request.get(`${API}/win-loss/reasons`);
    expect([401, 403]).toContain(res.status());
  });

  test('GET /win-loss/reasons returns array', async ({ request }) => {
    const res = await request.get(`${API}/win-loss/reasons`, { headers: auth() });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
  });

  test('POST /win-loss/reasons validates type+reason', async ({ request }) => {
    const res = await request.post(`${API}/win-loss/reasons`, {
      headers: auth(),
      data: { reason: 'Pricing too high' },
    });
    expect(res.status()).toBe(400);
  });

  test('POST /win-loss/reasons rejects unknown type', async ({ request }) => {
    const res = await request.post(`${API}/win-loss/reasons`, {
      headers: auth(),
      data: { type: 'maybe', reason: 'Pricing too high' },
    });
    expect(res.status()).toBe(400);
  });

  test('POST /win-loss/reasons creates a "lost" reason', async ({ request }) => {
    const tag = `E2E_AUDIT_${Date.now()}`;
    const res = await request.post(`${API}/win-loss/reasons`, {
      headers: auth(),
      data: { type: 'lost', reason: tag },
    });
    expect(res.status()).toBe(201);
    const body = await res.json();
    expect(body.id).toBeTruthy();
    expect(body.type).toBe('lost');
    expect(body.count).toBe(0);
    createdReasonIds.push(body.id);
  });

  test('POST /win-loss/reasons creates a "won" reason', async ({ request }) => {
    const tag = `E2E_AUDIT_won_${Date.now()}`;
    const res = await request.post(`${API}/win-loss/reasons`, {
      headers: auth(),
      data: { type: 'won', reason: tag },
    });
    expect(res.status()).toBe(201);
    const body = await res.json();
    expect(body.type).toBe('won');
    createdReasonIds.push(body.id);
  });

  test('GET /win-loss/analysis returns aggregated shape', async ({ request }) => {
    const res = await request.get(`${API}/win-loss/analysis`, { headers: auth() });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(typeof body.wonCount).toBe('number');
    expect(typeof body.lostCount).toBe('number');
    expect(typeof body.winRate).toBe('number');
    expect(Array.isArray(body.byReason)).toBe(true);
    expect(Array.isArray(body.closedDeals)).toBe(true);
    expect(body.avgDealSize).toBeTruthy();
  });

  test('GET /win-loss/analysis honors from/to range', async ({ request }) => {
    const res = await request.get(`${API}/win-loss/analysis?from=2026-01-01&to=2026-12-31`, {
      headers: auth(),
    });
    expect(res.status()).toBe(200);
  });

  test('PUT /win-loss/deals/:dealId/reason 404s for unknown deal', async ({ request }) => {
    const res = await request.put(`${API}/win-loss/deals/99999999/reason`, {
      headers: auth(),
      data: { lostReason: 'Pricing' },
    });
    expect(res.status()).toBe(404);
  });

  test('DELETE /win-loss/reasons/:id 404s for unknown id', async ({ request }) => {
    const res = await request.delete(`${API}/win-loss/reasons/99999999`, { headers: auth() });
    expect(res.status()).toBe(404);
  });
});
