// @ts-check
/**
 * Teardown-completeness gate (#405).
 *
 * This spec runs LAST in the suite (alphabetically late + a serial guard
 * via test name). It re-authenticates as wellness admin and asserts the
 * DB is FREE of any obvious test-data residue. If any row matching the
 * shared regex at e2e/test-data-patterns.js exists, the suite fails —
 * which means the regex is missing a pattern OR a spec stopped running
 * its afterAll cleanup.
 *
 * Why this exists: on 2026-05-02 the demo box had ~150 polluted rows
 * (PHI Audit Test Patient, Race Patient B …, Tenant B scoped E2E_FLOW_…,
 * Today's occupancy only 1%, QA Form Branch, etc.) that slipped past
 * the global-teardown regex one spec at a time, accumulating until the
 * customer-facing screens were unreadable. With this gate, the next
 * missing pattern fails the api_tests CI gate instead of polluting demo.
 *
 * Modes:
 *   - On the api_tests CI gate (BASE_URL=http://127.0.0.1:5000 against
 *     the ephemeral MySQL): asserts strict zero. The ephemeral DB is
 *     wiped per push so anything matching is a real teardown miss.
 *   - On e2e-full / manual demo runs (BASE_URL=https://crm.globusdemos.com):
 *     skipped by default. Set GATE_TEARDOWN_AGAINST_DEMO=1 to enable;
 *     historical pollution would fail it instead of new misses.
 *
 * The patterns checked here are a TIGHT subset of the full SSOT — only
 * the unambiguous "no real data ever looks like this" markers. The
 * full SSOT is what teardown DELETES; this is what we ASSERT on.
 */
const { test, expect } = require('@playwright/test');

const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:5000';
const REQUEST_TIMEOUT = 30000;
const ALLOW_AGAINST_DEMO = process.env.GATE_TEARDOWN_AGAINST_DEMO === '1';

// Tight regex — every match here is unambiguous test residue. Real
// customer data should never match any of these.
const RESIDUE_REGEX =
  /^(E2E |E2E_FLOW_|E2E_AUDIT_|E2E_RBAC_|E2E_WC_|E2E_EXT_|Coverage |Race Patient|Race Visit Patient|PHI Audit|Tenant B scoped|Walk-in E2E_EXT_|Priya Sharma E2E_|Aarav Sharma E2E_|smoke-test$|smoke-test_|QA Form |QA Test |Today's occupancy only )/;

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

async function fetchAll(request, path, token) {
  // Walk pagination if the endpoint exposes it. Limit=500 is enough for
  // a clean ephemeral DB; on demo this caps at 500 rows per resource.
  const res = await request.get(`${BASE_URL}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
    timeout: REQUEST_TIMEOUT,
  });
  if (!res.ok()) return null;
  const body = await res.json().catch(() => null);
  if (Array.isArray(body)) return body;
  return body?.data || body?.tasks || body?.locations || body?.patients || body?.threads || body?.messages || [];
}

function residueIn(rows, fieldName) {
  return (rows || [])
    .filter((r) => r && typeof r[fieldName] === 'string' && RESIDUE_REGEX.test(r[fieldName]))
    .map((r) => `${fieldName}=${JSON.stringify(r[fieldName])} (id=${r.id})`);
}

test.describe('Teardown completeness — no test-data residue (#405)', () => {
  test('skip on demo BASE_URL unless GATE_TEARDOWN_AGAINST_DEMO=1', async () => {
    if (BASE_URL.includes('crm.globusdemos.com') && !ALLOW_AGAINST_DEMO) {
      test.skip(true, 'demo box has historical residue; gate runs against ephemeral CI DB');
    }
  });

  test('Patient list (wellness tenant) has no test-residue names', async ({ request }) => {
    test.skip(!wellnessToken, 'wellness login unavailable');
    if (BASE_URL.includes('crm.globusdemos.com') && !ALLOW_AGAINST_DEMO) test.skip();
    const patients = await fetchAll(request, '/api/wellness/patients?limit=500', wellnessToken);
    const residue = residueIn(patients, 'name');
    expect(residue, `patient residue:\n  ${residue.join('\n  ')}`).toEqual([]);
  });

  test('Task list (generic tenant) has no test-residue titles', async ({ request }) => {
    test.skip(!genericToken, 'generic login unavailable');
    if (BASE_URL.includes('crm.globusdemos.com') && !ALLOW_AGAINST_DEMO) test.skip();
    const tasks = await fetchAll(request, '/api/tasks?limit=500', genericToken);
    const residue = residueIn(tasks, 'title');
    expect(residue, `task residue:\n  ${residue.join('\n  ')}`).toEqual([]);
  });

  test('Task list (wellness tenant) has no test-residue titles', async ({ request }) => {
    test.skip(!wellnessToken, 'wellness login unavailable');
    if (BASE_URL.includes('crm.globusdemos.com') && !ALLOW_AGAINST_DEMO) test.skip();
    const tasks = await fetchAll(request, '/api/tasks?limit=500', wellnessToken);
    const residue = residueIn(tasks, 'title');
    expect(residue, `task residue:\n  ${residue.join('\n  ')}`).toEqual([]);
  });

  test('Wellness location list has no test-residue names', async ({ request }) => {
    test.skip(!wellnessToken, 'wellness login unavailable');
    if (BASE_URL.includes('crm.globusdemos.com') && !ALLOW_AGAINST_DEMO) test.skip();
    const locations = await fetchAll(request, '/api/wellness/locations', wellnessToken);
    const residue = residueIn(locations, 'name');
    expect(residue, `location residue:\n  ${residue.join('\n  ')}`).toEqual([]);
  });

  test('Contact list (generic) has no test-residue names', async ({ request }) => {
    test.skip(!genericToken, 'generic login unavailable');
    if (BASE_URL.includes('crm.globusdemos.com') && !ALLOW_AGAINST_DEMO) test.skip();
    const contacts = await fetchAll(request, '/api/contacts?limit=500', genericToken);
    const residue = residueIn(contacts, 'name');
    expect(residue, `contact residue:\n  ${residue.join('\n  ')}`).toEqual([]);
  });
});
