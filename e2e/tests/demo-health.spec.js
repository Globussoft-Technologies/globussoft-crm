// @ts-check
/**
 * Demo health monitor — read-only assertions against the live demo box.
 *
 * Why this exists: the per-push api_tests gate validates a fix works on
 * a clean ephemeral DB. Nobody validates that the deployed demo
 * (`https://crm.globusdemos.com`) stays in a sane state between
 * deploys. On 2026-05-02 the wellness tenant on demo accumulated
 * ~150 polluted rows + had `Location.id=1` renamed from "Ranchi" to
 * "smoke-test" + the public booking widget showed an empty clinic
 * picker, all without CI noticing because none of those mutations
 * happened in the gate's ephemeral DB.
 *
 * This spec hits the demo (or any deployed env) with GETs only and
 * fails on each regression class that's hurt us before:
 *
 *   - #401: Kavita Reddy / Sneha Iyer / Aarav Sharma not duplicated
 *   - #402: GET /api/email?unread=1 returns 200 with list-or-count shape
 *   - #403: no "Tenant B scoped" tasks in wellness owner queue
 *   - #404: public booking returns >=1 location with non-empty city
 *   - #405: no test-data residue (E2E_*, Race_*, PHI Audit, etc.)
 *   - #406: canonical wellness SPA routes return 200
 *
 * SAFETY:
 *   - This spec NEVER writes. No POST, PUT, DELETE.
 *   - No fixture creation; no afterAll cleanup; nothing to leak.
 *   - Skipped unless BASE_URL points at a deployed env (contains
 *     "globusdemos.com" or DEMO_MONITOR=1 forces it). On localhost
 *     the spec is a no-op so it won't fail an unrelated dev run.
 *
 * Run modes:
 *   - Workflow_dispatch via .github/workflows/demo-monitor.yml
 *   - Manual: cd e2e && BASE_URL=https://crm.globusdemos.com \
 *             npx playwright test --project=chromium tests/demo-health.spec.js
 */
const { test, expect } = require('@playwright/test');

const BASE_URL = process.env.BASE_URL || 'https://crm.globusdemos.com';
const REQUEST_TIMEOUT = 15000;
const IS_DEPLOYED = /globusdemos\.com|crm\.|globussoft\.com/i.test(BASE_URL) || process.env.DEMO_MONITOR === '1';

// E2E_SKIP_SCRUB=1 (set in .github/workflows/e2e-full.yml) keeps the
// demo's accumulated test data intact for live walkthroughs. This
// monitor's whole point is detecting that residue — under SKIP_SCRUB
// the failures are not signalling a real regression, just confirming
// the design choice. Set DEMO_MONITOR=1 to force-run anyway (the
// scheduled demo-monitor.yml workflow does this).
test.skip(
  process.env.E2E_SKIP_SCRUB === '1' && process.env.DEMO_MONITOR !== '1',
  'demo-health assumes scrubbed state; under E2E_SKIP_SCRUB=1 it duplicates the demo-monitor.yml schedule'
);

test.describe('Demo health monitor (read-only)', () => {
  test.skip(!IS_DEPLOYED, 'BASE_URL is not a deployed env — skipping (set DEMO_MONITOR=1 to force)');

  let wellnessToken = null;
  let genericToken = null;

  test.beforeAll(async ({ request }) => {
    const wellnessLogin = await request.post(`${BASE_URL}/api/auth/login`, {
      data: { email: 'admin@wellness.demo', password: 'password123' },
      headers: { 'Content-Type': 'application/json' },
      timeout: REQUEST_TIMEOUT,
    });
    if (wellnessLogin.ok()) wellnessToken = (await wellnessLogin.json()).token;

    const genericLogin = await request.post(`${BASE_URL}/api/auth/login`, {
      data: { email: 'admin@globussoft.com', password: 'password123' },
      headers: { 'Content-Type': 'application/json' },
      timeout: REQUEST_TIMEOUT,
    });
    if (genericLogin.ok()) genericToken = (await genericLogin.json()).token;
  });

  // ── Health + auth — bare minimum ────────────────────────────────────

  test('GET /api/health returns healthy', async ({ request }) => {
    // #543 (MED-02): /api/health is two-tier — `database` only surfaces
    // for authed callers. Probe with an Authorization header so we can
    // still pin the DB-connectivity assertion (the original intent of
    // this demo-health monitor; an unauth probe would only get
    // status+timestamp).
    const tokenForFullShape = wellnessToken || genericToken;
    const headers = tokenForFullShape ? { Authorization: `Bearer ${tokenForFullShape}` } : {};
    const res = await request.get(`${BASE_URL}/api/health`, { headers, timeout: REQUEST_TIMEOUT });
    expect(res.status(), `health endpoint returned ${res.status()}`).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('healthy');
    if (tokenForFullShape) {
      expect(body.database).toBe('connected');
    }
  });

  test('demo logins succeed (admin@wellness.demo + admin@globussoft.com)', () => {
    expect(wellnessToken, 'admin@wellness.demo login failed').toBeTruthy();
    expect(genericToken, 'admin@globussoft.com login failed').toBeTruthy();
  });

  // ── #401 — Patient duplicates not regrowing ─────────────────────────

  test('#401 — no patient name appears more than 2x (e.g. Kavita Reddy x10 must not return)', async ({ request }) => {
    test.skip(!wellnessToken, 'wellness login required');
    const res = await request.get(`${BASE_URL}/api/wellness/patients?limit=500`, {
      headers: { Authorization: `Bearer ${wellnessToken}` },
      timeout: REQUEST_TIMEOUT,
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    const patients = Array.isArray(body) ? body : (body.patients || body.data || []);

    const counts = {};
    for (const p of patients) {
      const name = (p.name || '').trim();
      if (!name) continue;
      counts[name] = (counts[name] || 0) + 1;
    }
    const dupes = Object.entries(counts).filter(([_, n]) => n > 2);
    expect(dupes, `patient duplicates (>2x): ${JSON.stringify(dupes)}`).toEqual([]);
  });

  // ── #402 — sidebar inbox counter doesn't 404 ────────────────────────

  test('#402 — GET /api/email?unread=1 returns 200 with list-or-count shape (no red toast)', async ({ request }) => {
    test.skip(!wellnessToken, 'wellness login required');
    const res = await request.get(`${BASE_URL}/api/email?unread=1`, {
      headers: { Authorization: `Bearer ${wellnessToken}` },
      timeout: REQUEST_TIMEOUT,
    });
    expect(res.status()).toBe(200);
    const body = await res.json().catch(() => null);
    const ok = Array.isArray(body) ||
      (body && typeof body === 'object' && ('total' in body || Array.isArray(body.threads) || Array.isArray(body.messages)));
    expect(ok, `unexpected /api/email shape: ${JSON.stringify(body).slice(0, 200)}`).toBe(true);
  });

  // ── #403 — no cross-tenant task leak ────────────────────────────────

  test('#403 — wellness owner task queue contains no "Tenant B scoped" rows', async ({ request }) => {
    test.skip(!wellnessToken, 'wellness login required');
    const res = await request.get(`${BASE_URL}/api/tasks?limit=500`, {
      headers: { Authorization: `Bearer ${wellnessToken}` },
      timeout: REQUEST_TIMEOUT,
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    const tasks = Array.isArray(body) ? body : (body.tasks || body.data || []);
    const leaked = tasks.filter((t) => /^Tenant B scoped/.test(t.title || ''));
    expect(leaked.map((t) => t.title), 'cross-tenant task leak detected').toEqual([]);
  });

  // ── #404 — public booking shows clinics ─────────────────────────────

  test('#404 — public booking endpoint returns >=1 location with non-empty city', async ({ request }) => {
    const res = await request.get(`${BASE_URL}/api/wellness/public/tenant/enhanced-wellness`, {
      timeout: REQUEST_TIMEOUT,
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.locations)).toBe(true);
    expect(body.locations.length, 'public booking widget would show empty clinic picker').toBeGreaterThanOrEqual(1);

    const INTERNAL = /^(smoke-test|e2e[-_ ]|test[-_ ]|qa[-_ ]|dev[-_ ])/i;
    const leaked = body.locations.filter((l) => INTERNAL.test(l.name || ''));
    expect(leaked.map((l) => l.name), 'internal-named locations leaked into public response').toEqual([]);

    const noCity = body.locations.filter((l) => !l.city);
    expect(noCity.map((l) => l.name), 'locations missing city render as "(unknown)" on widget').toEqual([]);
  });

  // ── #405 — no test-data residue on demo ─────────────────────────────

  // Tight regex (matches the one in tests/teardown-completeness.spec.js).
  // Every match here is unambiguous test residue — real customer data
  // should never look like any of these.
  const RESIDUE_REGEX =
    /^(E2E |E2E_FLOW_|E2E_AUDIT_|E2E_RBAC_|E2E_WC_|E2E_EXT_|Coverage |Race Patient|Race Visit Patient|PHI Audit|Tenant B scoped|Walk-in E2E_EXT_|Priya Sharma E2E_|Aarav Sharma E2E_|smoke-test$|smoke-test_|QA Form |QA Test |Today's occupancy only )/;

  test('#405 — wellness Patient list has no test-residue names', async ({ request }) => {
    test.skip(!wellnessToken, 'wellness login required');
    const res = await request.get(`${BASE_URL}/api/wellness/patients?limit=500`, {
      headers: { Authorization: `Bearer ${wellnessToken}` },
      timeout: REQUEST_TIMEOUT,
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    const patients = Array.isArray(body) ? body : (body.patients || body.data || []);
    const residue = patients
      .filter((p) => RESIDUE_REGEX.test(p.name || ''))
      .map((p) => `id=${p.id}: ${JSON.stringify(p.name)}`);
    expect(residue, `patient residue (top 10): ${residue.slice(0, 10).join('; ')}`).toEqual([]);
  });

  test('#405 — wellness Location list has no test-residue names with isActive=true', async ({ request }) => {
    test.skip(!wellnessToken, 'wellness login required');
    const res = await request.get(`${BASE_URL}/api/wellness/locations`, {
      headers: { Authorization: `Bearer ${wellnessToken}` },
      timeout: REQUEST_TIMEOUT,
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    const locs = Array.isArray(body) ? body : (body.locations || body.data || []);
    const residue = locs
      .filter((l) => RESIDUE_REGEX.test(l.name || '') && l.isActive)
      .map((l) => `id=${l.id}: ${JSON.stringify(l.name)} (active)`);
    expect(residue, `active location residue: ${residue.slice(0, 10).join('; ')}`).toEqual([]);
  });

  test('#405 — wellness Task queue has no test-residue titles', async ({ request }) => {
    test.skip(!wellnessToken, 'wellness login required');
    const res = await request.get(`${BASE_URL}/api/tasks?limit=500`, {
      headers: { Authorization: `Bearer ${wellnessToken}` },
      timeout: REQUEST_TIMEOUT,
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    const tasks = Array.isArray(body) ? body : (body.tasks || body.data || []);
    const residue = tasks
      .filter((t) => RESIDUE_REGEX.test(t.title || ''))
      .map((t) => `id=${t.id}: ${JSON.stringify(t.title)}`);
    expect(residue, `task residue (top 10): ${residue.slice(0, 10).join('; ')}`).toEqual([]);
  });

  // ── #406 — canonical wellness SPA routes return 200 ─────────────────

  const WELLNESS_ROUTES = [
    '/wellness',
    '/wellness/patients',
    '/wellness/services',
    '/wellness/telecaller',
    '/wellness/calendar',
    '/wellness/locations',
    '/wellness/loyalty',
    '/wellness/reports',
  ];

  for (const route of WELLNESS_ROUTES) {
    test(`#406 — ${route} returns 200 with React shell`, async ({ request }) => {
      const res = await request.get(`${BASE_URL}${route}`, { timeout: REQUEST_TIMEOUT });
      expect(res.status(), `${route}: nginx history-fallback misconfig?`).toBe(200);
      const html = await res.text();
      expect(html, `${route}: served something other than the SPA shell`).toContain('<div id="root">');
    });
  }
});
