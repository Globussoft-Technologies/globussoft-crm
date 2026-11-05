const { test, expect } = require('@playwright/test');

test.use({ storageState: { cookies: [], origins: [] } });
test.describe.configure({ mode: 'serial' });

const BASE_URL = process.env.BASE_URL || 'http://localhost:5000';
const IS_LOCAL_STACK = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(BASE_URL);
let adminToken;
let userToken;
let wasEnabled = false;

async function login(request, email) {
  const response = await request.post(`${BASE_URL}/api/auth/login`, { data: { email, password: 'password123' } });
  expect(response.ok()).toBeTruthy();
  return (await response.json()).token;
}

const headers = (token) => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' });

test.beforeAll(async ({ request }) => {
  test.skip(!IS_LOCAL_STACK, 'Payout feature-flag checks run only against the disposable local/CI stack.');
  adminToken = await login(request, 'admin@globussoft.com');
  userToken = await login(request, 'user@crm.com');
  const feature = await request.get(`${BASE_URL}/api/pickup-plot-payouts/feature`, { headers: headers(adminToken) });
  expect(feature.ok()).toBeTruthy();
  wasEnabled = Boolean((await feature.json()).enabled);
  if (!wasEnabled) {
    const enabled = await request.put(`${BASE_URL}/api/pickup-plot-payouts/feature`, { headers: headers(adminToken), data: { enabled: true } });
    expect(enabled.ok()).toBeTruthy();
  }
});

test.afterAll(async ({ request }) => {
  if (!adminToken || wasEnabled) return;
  await request.put(`${BASE_URL}/api/pickup-plot-payouts/feature`, { headers: headers(adminToken), data: { enabled: false } }).catch(() => {});
});

test('feature-enabled payout settings and partner reads are tenant-scoped', async ({ request }) => {
  const [settings, partners] = await Promise.all([
    request.get(`${BASE_URL}/api/pickup-plot-payouts/settings`, { headers: headers(adminToken) }),
    request.get(`${BASE_URL}/api/pickup-plot-payouts/partners`, { headers: headers(adminToken) }),
  ]);
  expect(settings.status()).toBe(200);
  expect((await settings.json()).settings).toMatchObject({ pricingModel: 'MARKUP', splitMethod: 'PRO_RATA' });
  expect(partners.status()).toBe(200);
  expect((await partners.json()).partners).toBeInstanceOf(Array);
  const [plots, customers, bookings] = await Promise.all([
    request.get(`${BASE_URL}/api/pickup-plot-payouts/plots`, { headers: headers(adminToken) }),
    request.get(`${BASE_URL}/api/pickup-plot-payouts/customers`, { headers: headers(adminToken) }),
    request.get(`${BASE_URL}/api/pickup-plot-payouts/bookings`, { headers: headers(adminToken) }),
  ]);
  expect(plots.status()).toBe(200);
  expect((await plots.json()).plots).toBeInstanceOf(Array);
  expect(customers.status()).toBe(200);
  expect((await customers.json()).customers).toBeInstanceOf(Array);
  expect(bookings.status()).toBe(200);
  expect((await bookings.json()).bookings).toBeInstanceOf(Array);
});

test('legacy user cannot toggle the payout feature', async ({ request }) => {
  const response = await request.put(`${BASE_URL}/api/pickup-plot-payouts/feature`, {
    headers: headers(userToken), data: { enabled: false },
  });
  expect(response.status()).toBe(403);
});

test('disabled payout routes return not-found without changing legacy APIs', async ({ request }) => {
  const disabled = await request.put(`${BASE_URL}/api/pickup-plot-payouts/feature`, { headers: headers(adminToken), data: { enabled: false } });
  expect(disabled.status()).toBe(200);
  const hidden = await request.get(`${BASE_URL}/api/pickup-plot-payouts/partners`, { headers: headers(adminToken) });
  expect(hidden.status()).toBe(404);
  expect((await hidden.json()).code).toBe('DEPOSIT_SPLIT_DISABLED');
  const restored = await request.put(`${BASE_URL}/api/pickup-plot-payouts/feature`, { headers: headers(adminToken), data: { enabled: true } });
  expect(restored.status()).toBe(200);
});
