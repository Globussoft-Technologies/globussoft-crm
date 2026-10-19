const { test, expect } = require('@playwright/test');
const BASE_URL = process.env.BASE_URL || 'http://localhost:5000';
test.describe.configure({ mode: 'serial' });
const tag = `E2E_FX_${process.pid}_${Date.now()}`;
let headers;
const ids = [];

test.beforeAll(async ({ request }) => {
  const response = await request.post(`${BASE_URL}/api/auth/login`, {
    data: { email: 'admin@globussoft.com', password: 'password123' },
  });
  expect(response.ok()).toBe(true);
  headers = { Authorization: `Bearer ${(await response.json()).token}` };
});
test.afterAll(async ({ request }) => {
  for (const id of ids) await request.delete(`${BASE_URL}/api/deals/${id}`, { headers });
});

test('market valuation converts filtered deals or explicitly marks missing rates', async ({ request }) => {
  for (const [currency, amount] of [['USD', 100], ['INR', 8000]]) {
    const created = await request.post(`${BASE_URL}/api/deals`, {
      headers, data: { title: `${tag}_${currency}`, currency, amount, stage: 'won', probability: 100 },
    });
    expect(created.ok()).toBe(true);
    ids.push((await created.json()).id);
  }
  const response = await request.get(`${BASE_URL}/api/deals/stats?currencyMode=latest&search=${tag}`, { headers });
  expect(response.ok()).toBe(true);
  const stats = await response.json();
  expect(stats.totalDeals).toBe(2);
  expect(stats.fx.baseCurrency).toMatch(/^[A-Z]{3}$/);
  if (stats.fx.incomplete) {
    expect(stats.wonValue).toBeNull();
    expect(stats.fx.missingCurrencies.length).toBeGreaterThan(0);
  } else {
    expect(stats.wonValue).toBeCloseTo(100 * stats.fx.rates.USD + 8000 * stats.fx.rates.INR, 6);
  }
  // Market valuation must never mutate the original deal amount or currency.
  const original = await request.get(`${BASE_URL}/api/deals/${ids[1]}`, { headers });
  expect(await original.json()).toMatchObject({ amount: 8000, currency: 'INR' });
});

test('requires authentication and preserves the legacy stats contract', async ({ request }) => {
  const denied = await request.get(`${BASE_URL}/api/deals/stats?currencyMode=latest`);
  expect([401, 403]).toContain(denied.status());
  const legacy = await request.get(`${BASE_URL}/api/deals/stats?search=${tag}`, { headers });
  const stats = await legacy.json();
  expect(stats.fx).toBeUndefined();
  expect(stats.wonValue).toBe(8100);
});

test('Wellness cannot read Generic deals and retains its existing currency behavior', async ({ request }) => {
  const login = await request.post(`${BASE_URL}/api/auth/login`, {
    data: { email: 'admin@wellness.demo', password: 'password123' },
  });
  expect(login.ok()).toBe(true);
  const wellnessHeaders = { Authorization: `Bearer ${(await login.json()).token}` };
  const response = await request.get(`${BASE_URL}/api/deals/stats?currencyMode=latest&search=${tag}`, { headers: wellnessHeaders });
  if (response.status() === 403) return; // Cross-vertical access may be denied entirely.
  expect(response.ok()).toBe(true);
  expect(await response.json()).toMatchObject({ totalDeals: 0 });
  expect((await response.json()).fx).toBeUndefined();
});
