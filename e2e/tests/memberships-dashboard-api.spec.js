// @ts-check
/**
 * Memberships dashboard API — Wave 7D (PRD Gap §4 item 8).
 *
 * Target: backend/routes/wellness.js — GET /api/wellness/memberships/dashboard.
 *
 * The Memberships page surfaces 3 summary cards above the existing plan-list:
 *   - Active count + total deferred-revenue (sum of plan.price * remainingFraction)
 *   - Expiring this week (active + endDate within next 7 days)
 *   - Expired (status='expired' OR endDate < now)
 *
 * The endpoint is admin/manager-gated via verifyWellnessRole(['admin','manager'])
 * and tenant-scoped (only same-tenant memberships counted).
 *
 * Acceptance:
 *   ✅ Auth gate: no token → 401/403
 *   ✅ RBAC: doctor/professional/telecaller → 403 (admin/manager only)
 *   ✅ Happy path: returns the 3 documented aggregate fields
 *   ✅ Tenant isolation: generic admin sees zero counts (no wellness data
 *     leaks; backend's verifyWellnessRole will hard-bounce a generic admin
 *     because Tenant.vertical=generic).
 *
 * Test environment:
 *   - BASE_URL defaults to https://crm.globusdemos.com (matches other gate specs)
 *   - Local: cd e2e && BASE_URL=http://127.0.0.1:5000 npx playwright test \
 *            --project=chromium --no-deps tests/memberships-dashboard-api.spec.js
 *   - Login: admin@wellness.demo / password123 (wellness admin)
 *            drharsh@enhancedwellness.in / password123 (doctor — should 403)
 *            admin@globussoft.com / password123 (generic — should 403 / WELLNESS_TENANT_REQUIRED)
 *
 * RUN_TAG: E2E_FLOW_MEMB_DASH_<ts> — matches the global /^E2E_FLOW_/ teardown
 * sweep pattern (no rows are mutated; the test is read-only).
 */
const { test, expect } = require('@playwright/test');

test.describe.configure({ mode: 'serial' });

const BASE_URL = process.env.BASE_URL || 'https://crm.globusdemos.com';
const API = `${BASE_URL}/api`;

const FIXTURES = {
  wellnessAdmin: { email: 'admin@wellness.demo', password: 'password123' },
  drharsh:       { email: 'drharsh@enhancedwellness.in', password: 'password123' },
  generic:       { email: 'admin@globussoft.com', password: 'password123' },
};

const tokens = {};

async function login(request, who) {
  if (tokens[who]) return tokens[who];
  const fx = FIXTURES[who];
  const res = await request.post(`${API}/auth/login`, { data: fx });
  if (!res.ok()) return '';
  const body = await res.json();
  tokens[who] = body.token || '';
  return tokens[who];
}

const headers = (tok) => ({ Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' });

test.describe('Memberships dashboard — Wave 7D', () => {
  test('GET without token → 401/403', async ({ request }) => {
    const res = await request.get(`${API}/wellness/memberships/dashboard`);
    expect([401, 403]).toContain(res.status());
  });

  test('admin@wellness.demo → 200 with 3 documented aggregates', async ({ request }) => {
    const tok = await login(request, 'wellnessAdmin');
    test.skip(!tok, 'wellness admin login failed');
    const res = await request.get(`${API}/wellness/memberships/dashboard`, { headers: headers(tok) });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.active).toBeDefined();
    expect(typeof body.active.count).toBe('number');
    expect(typeof body.active.deferredRevenue).toBe('number');
    expect(body.expiringThisWeek).toBeDefined();
    expect(typeof body.expiringThisWeek.count).toBe('number');
    expect(body.expired).toBeDefined();
    expect(typeof body.expired.count).toBe('number');
    expect(body.asOf).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test('doctor (drharsh) → 403 (admin/manager only)', async ({ request }) => {
    const tok = await login(request, 'drharsh');
    test.skip(!tok, 'doctor login failed');
    const res = await request.get(`${API}/wellness/memberships/dashboard`, { headers: headers(tok) });
    // verifyWellnessRole(['admin','manager']) should hard-403 a doctor
    expect([401, 403]).toContain(res.status());
  });

  test('generic-tenant admin → 403 (wellness-only route)', async ({ request }) => {
    const tok = await login(request, 'generic');
    test.skip(!tok, 'generic admin login failed');
    const res = await request.get(`${API}/wellness/memberships/dashboard`, { headers: headers(tok) });
    // verifyWellnessRole gates Tenant.vertical=wellness — generic should
    // get 401/403 with WELLNESS_TENANT_REQUIRED-shaped payload.
    expect([401, 403]).toContain(res.status());
  });

  test('aggregates are non-negative + deferredRevenue is finite', async ({ request }) => {
    const tok = await login(request, 'wellnessAdmin');
    test.skip(!tok, 'wellness admin login failed');
    const res = await request.get(`${API}/wellness/memberships/dashboard`, { headers: headers(tok) });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.active.count).toBeGreaterThanOrEqual(0);
    expect(body.expiringThisWeek.count).toBeGreaterThanOrEqual(0);
    expect(body.expired.count).toBeGreaterThanOrEqual(0);
    expect(body.active.deferredRevenue).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(body.active.deferredRevenue)).toBe(true);
  });
});
