// @ts-check
/**
 * Customer/user transaction-history API contract.
 *
 * NEW route added to backend/routes/wellness.js (this commit):
 *
 *   GET /api/wellness/my-transactions   — any authenticated tenant user
 *
 * Resolves the caller's OWN Patient (via Patient.userId), then aggregates
 * every money-touching record tied to that patient into one normalised,
 * date-sorted timeline + a summary block. Not mounted under /portal, so it
 * authenticates via the normal app JWT (global guard) and works for BOTH a
 * customer-tier USER and a self-registered CUSTOMER.
 *
 * What this spec pins:
 *   - Auth gate: 401/403 with no token.
 *   - Envelope shape: { currency, summary, transactions[] }.
 *   - Summary carries all seven numeric keys.
 *   - Summary identity: totalPaid === posTotal + onlineTotal + subscriptionsTotal
 *     (the documented de-dup math — wallet top-ups are NOT folded in).
 *   - Each transaction (when present) has the normalised keys and a
 *     direction ∈ {debit, credit}.
 *   - A signed-in user with NO linked Patient gets an empty history (200,
 *     not 404) — the page renders a clean empty state.
 *   - Scope isolation: a generic-tenant admin (no wellness Patient) never
 *     sees wellness-tenant transactions through this endpoint.
 *   - Optional ?from/?to date filtering returns the same valid shape.
 *
 * The endpoint works for USER + CUSTOMER alike; the demo USER fixture is
 * exercised to pin that the non-portal auth path accepts a plain USER token.
 */
const { test, expect } = require('@playwright/test');

const BASE_URL = process.env.BASE_URL || 'https://crm.globusdemos.com';
const REQUEST_TIMEOUT = 60000;
const PATH = '/api/wellness/my-transactions';

const FIXTURES = {
  wellnessAdmin: { email: 'admin@wellness.demo', password: 'password123' },
  wellnessUser: { email: 'user@wellness.demo', password: 'password123' },
  genericAdmin: { email: 'admin@globussoft.com', password: 'password123' },
};

const tokenCache = {};

async function login(request, who) {
  if (who in tokenCache) return tokenCache[who];
  const r = await request.post(`${BASE_URL}/api/auth/login`, {
    data: FIXTURES[who],
    headers: { 'Content-Type': 'application/json' },
    timeout: REQUEST_TIMEOUT,
  });
  tokenCache[who] = r.ok() ? (await r.json()).token : null;
  return tokenCache[who];
}

const headers = (token) => ({
  Authorization: `Bearer ${token}`,
  'Content-Type': 'application/json',
});

async function get(request, token, path = PATH) {
  return request.get(`${BASE_URL}${path}`, {
    headers: headers(token),
    timeout: REQUEST_TIMEOUT,
  });
}

const SUMMARY_KEYS = [
  'totalPaid',
  'posTotal',
  'onlineTotal',
  'subscriptionsTotal',
  'walletBalance',
  'walletTopUps',
  'transactionCount',
];

const REQUIRED_TXN_KEYS = ['id', 'type', 'category', 'title', 'amount', 'direction', 'status', 'date'];

test.describe('GET /api/wellness/my-transactions', () => {
  test('requires authentication (401/403 with no token)', async ({ request }) => {
    const r = await request.get(`${BASE_URL}${PATH}`, { timeout: REQUEST_TIMEOUT });
    expect([401, 403]).toContain(r.status());
  });

  test('returns the { currency, summary, transactions } envelope for an authenticated user', async ({ request }) => {
    const token = await login(request, 'wellnessAdmin');
    test.skip(!token, 'wellness admin login failed');
    const r = await get(request, token);
    expect(r.ok()).toBeTruthy();
    const body = await r.json();
    expect(typeof body.currency).toBe('string');
    expect(body.summary).toBeTruthy();
    expect(Array.isArray(body.transactions)).toBe(true);
  });

  test('summary carries all seven numeric keys', async ({ request }) => {
    const token = await login(request, 'wellnessAdmin');
    test.skip(!token, 'wellness admin login failed');
    const { summary } = await (await get(request, token)).json();
    for (const k of SUMMARY_KEYS) {
      expect(summary, `summary should have ${k}`).toHaveProperty(k);
      expect(typeof summary[k], `${k} should be a number`).toBe('number');
    }
  });

  test('totalPaid equals posTotal + onlineTotal + subscriptionsTotal (de-dup math)', async ({ request }) => {
    const token = await login(request, 'wellnessAdmin');
    test.skip(!token, 'wellness admin login failed');
    const { summary } = await (await get(request, token)).json();
    const recomputed = summary.posTotal + summary.onlineTotal + summary.subscriptionsTotal;
    // Float tolerance — these are currency sums.
    expect(Math.abs(summary.totalPaid - recomputed)).toBeLessThan(0.01);
    // Wallet top-ups are intentionally NOT folded into totalPaid.
    expect(summary).toHaveProperty('walletTopUps');
  });

  test('each transaction (when present) has the normalised keys + valid direction', async ({ request }) => {
    const token = await login(request, 'wellnessAdmin');
    test.skip(!token, 'wellness admin login failed');
    const { transactions } = await (await get(request, token)).json();
    test.skip(transactions.length === 0, 'no transactions to shape-check on this demo state');
    for (const t of transactions.slice(0, 25)) {
      for (const k of REQUIRED_TXN_KEYS) {
        expect(t, `txn should have ${k}`).toHaveProperty(k);
      }
      expect(['debit', 'credit']).toContain(t.direction);
      expect(typeof t.amount).toBe('number');
    }
  });

  test('transactions are sorted newest-first by date', async ({ request }) => {
    const token = await login(request, 'wellnessAdmin');
    test.skip(!token, 'wellness admin login failed');
    const { transactions } = await (await get(request, token)).json();
    test.skip(transactions.length < 2, 'need ≥2 transactions to assert ordering');
    for (let i = 1; i < transactions.length; i++) {
      const prev = new Date(transactions[i - 1].date).getTime();
      const cur = new Date(transactions[i].date).getTime();
      expect(prev).toBeGreaterThanOrEqual(cur);
    }
  });

  test('works for a plain USER role (non-portal auth path accepts user token)', async ({ request }) => {
    const token = await login(request, 'wellnessUser');
    test.skip(!token, 'wellness user login failed');
    const r = await get(request, token);
    expect(r.ok()).toBeTruthy();
    const body = await r.json();
    expect(Array.isArray(body.transactions)).toBe(true);
    expect(body.summary).toHaveProperty('totalPaid');
  });

  test('a user with no linked Patient gets an empty history (200, not 404)', async ({ request }) => {
    // The generic-tenant admin is not a wellness Patient — the endpoint
    // resolves no Patient for them and returns an empty, zeroed envelope
    // rather than erroring. This also pins scope isolation: no wellness
    // transactions leak to a different tenant's user.
    const token = await login(request, 'genericAdmin');
    test.skip(!token, 'generic admin login failed');
    const r = await get(request, token);
    expect(r.ok()).toBeTruthy();
    const body = await r.json();
    expect(Array.isArray(body.transactions)).toBe(true);
    expect(body.transactions.length).toBe(0);
    expect(body.summary.totalPaid).toBe(0);
    expect(body.summary.transactionCount).toBe(0);
  });

  test('accepts ?from / ?to date filtering and returns the same valid shape', async ({ request }) => {
    const token = await login(request, 'wellnessAdmin');
    test.skip(!token, 'wellness admin login failed');
    const from = '2000-01-01T00:00:00.000Z';
    const to = '2100-01-01T00:00:00.000Z';
    const r = await get(request, token, `${PATH}?from=${from}&to=${to}`);
    expect(r.ok()).toBeTruthy();
    const body = await r.json();
    expect(Array.isArray(body.transactions)).toBe(true);
    expect(body.summary).toHaveProperty('totalPaid');
  });

  test('ignores malformed date params (does not 500)', async ({ request }) => {
    const token = await login(request, 'wellnessAdmin');
    test.skip(!token, 'wellness admin login failed');
    const r = await get(request, token, `${PATH}?from=not-a-date&to=garbage`);
    expect(r.ok()).toBeTruthy();
    const body = await r.json();
    expect(Array.isArray(body.transactions)).toBe(true);
  });
});
