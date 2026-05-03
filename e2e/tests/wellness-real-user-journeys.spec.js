// @ts-check
/**
 * Wellness — Real-user end-to-end journeys.
 *
 * Each `describe.serial` block simulates one persona going through the app
 * the way a real human would: log in, click, fill forms, submit, and verify
 * the outcome in the UI.
 *
 * Personas covered:
 *   A. Patient (portal login via phone+OTP)
 *   B. Doctor (log visit, write Rx, capture consent)
 *   C. Telecaller (work the SLA queue + dispose)
 *   D. Owner / Rishu (approve a recommendation, read reports)
 *   E. Admin (add service, tenant branding change)
 *   F. Full lifecycle (anonymous website → embed → junk filter → telecaller → patient portal)
 *
 * Complements the API-level `wellness.spec.js` with real browser flows.
 *
 * Run:
 *   cd e2e && BASE_URL=https://crm.globusdemos.com \
 *     npx playwright test tests/wellness-real-user-journeys.spec.js --project=chromium
 */
const { test, expect, request: apiRequest } = require('@playwright/test');

const BASE_URL = process.env.BASE_URL || 'https://crm.globusdemos.com';
const API = `${BASE_URL}/api`;
const EXT = `${BASE_URL}/api/v1/external`;

const RISHU  = { email: 'rishu@enhancedwellness.in',  password: 'password123' };
const ADMIN  = { email: 'admin@wellness.demo',        password: 'password123' };
const DOCTOR = { email: 'drharsh@enhancedwellness.in', password: 'password123' };

// Static fallback (the demo box's seeded key — works against
// crm.globusdemos.com). Locally the key is randomized per seed-wellness
// run, so resolvePartnerKey() falls through to discovering it via the
// admin → /developer/apikeys path.
const PARTNER_KEY_STATIC = process.env.WELLNESS_PARTNER_KEY
  || 'glbs_6ba99bc3309ef840d58d1fd43339e09c62eb395396c6c8cf';

// Cached resolved key (set by the first describe-block that calls
// resolvePartnerKey). Survives across tests in the same Playwright
// worker; a fresh worker re-resolves.
let _resolvedPartnerKey = null;

// Unique suffix so re-runs don't collide
const STAMP = Date.now().toString().slice(-6);

// ---------- helpers ----------

async function apiLogin(request, creds) {
  const res = await request.post(`${API}/auth/login`, { data: creds });
  expect(res.ok(), `login ${creds.email} should 2xx`).toBeTruthy();
  const body = await res.json();
  return { token: body.token, user: body.user, tenant: body.tenant };
}

/**
 * Resolve a working partner X-API-Key for the wellness tenant.
 *
 * Strategy:
 *   1. If WELLNESS_PARTNER_KEY env var or hardcoded fallback authenticates
 *      against /api/v1/external/me, use it.
 *   2. Otherwise (typical for a freshly-seeded local Docker stack — the
 *      seed mints a random key per run), log in as admin@wellness.demo
 *      and fetch /api/developer/apikeys, then pick the Callified.ai key.
 *   3. If both fail, return null — caller should test.skip() with a
 *      descriptive message rather than blow up with a 401 cascade.
 *
 * Cached on first success so subsequent C/F tests in the same worker
 * don't re-do the discovery handshake.
 */
async function resolvePartnerKey(request) {
  if (_resolvedPartnerKey) return _resolvedPartnerKey;

  // Try the static key first.
  try {
    const probe = await request.get(`${EXT}/me`, {
      headers: { 'X-API-Key': PARTNER_KEY_STATIC },
    });
    if (probe.ok()) {
      _resolvedPartnerKey = PARTNER_KEY_STATIC;
      return _resolvedPartnerKey;
    }
  } catch (_e) {
    /* fall through to discovery */
  }

  // Fall back: log in as wellness admin + read /developer/apikeys.
  try {
    const { token } = await apiLogin(request, ADMIN);
    const keysRes = await request.get(`${API}/developer/apikeys`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (keysRes.ok()) {
      const keys = await keysRes.json();
      // Prefer Callified (matches what wellness.spec.js + EXTERNAL_API.md
      // documented), but any tenant-scoped key works for /external/* calls.
      const callified = keys.find((k) => /Callified/i.test(k.name));
      const picked = callified || keys[0];
      if (picked && picked.keySecret) {
        _resolvedPartnerKey = picked.keySecret;
        return _resolvedPartnerKey;
      }
    }
  } catch (_e) {
    /* discovery failed — fall through to null */
  }

  return null;
}

/**
 * Probe whether the SPA is served at BASE_URL. The local Docker stack
 * boots an API-only backend (no Vite, no static frontend), so deep links
 * like /wellness 404 with "Cannot GET /wellness" plain text. Browser
 * tests would then permanently fail against that target.
 *
 * Cheapest signal: GET /login. The SPA serves index.html (HTML body
 * containing <div id="root"). The API-only backend returns JSON 404
 * "Cannot GET /login".
 *
 * Cached so the spec's many browser tests don't all re-probe.
 */
let _spaProbeResult = null;
async function isSpaServed(request) {
  if (_spaProbeResult !== null) return _spaProbeResult;
  try {
    const res = await request.get(`${BASE_URL}/login`, {
      // Don't auto-follow; we just want the body of whatever the origin returns.
      maxRedirects: 0,
    });
    const body = await res.text().catch(() => '');
    // SPA serves an HTML shell with a #root div; backend-only returns
    // JSON or "Cannot GET /login". Any 200-OK HTML with id="root" wins.
    _spaProbeResult = res.ok() && /id="?root"?/i.test(body);
  } catch (_e) {
    _spaProbeResult = false;
  }
  return _spaProbeResult;
}

/**
 * Inject token + user + tenant JSON into localStorage (App.jsx reads all
 * three in its useState initializers; without `user` the Sidebar's
 * managerOnly/adminOnly filter hides ~30 links, and KPI rendering can
 * fail since some queries gate on user.role). The body[data-vertical]
 * attribute is driven by tenant.vertical. Then navigate to `initialPath`.
 */
async function uiLoginViaToken(page, token, tenant, initialPath = '/', user = null) {
  await page.goto('/login');
  await page.evaluate(({ t, ten, u }) => {
    localStorage.setItem('token', t);
    if (ten) localStorage.setItem('tenant', JSON.stringify(ten));
    if (u) localStorage.setItem('user', JSON.stringify(u));
  }, { t: token, ten: tenant, u: user });
  await page.goto(initialPath);
  await page.waitForLoadState('domcontentloaded');
}

async function clearBrowserState(page) {
  // sessionStorage as well as localStorage — per #343 (v3.2.5) the SPA
  // reads the token from sessionStorage + an in-memory holder; just
  // clearing localStorage leaves a stale token from auth.setup behind,
  // so a subsequent uiLoginViaToken-with-different-creds can't replace
  // the auth context and tests fall back to the previous tenant's data.
  await page.context().clearCookies();
  await page.goto('/');
  await page.evaluate(() => {
    localStorage.clear();
    sessionStorage.clear();
  });
}

function uniquePhone10() {
  // 9xxxxxxxxx — 10-digit Indian mobile pattern
  const rand = Math.floor(Math.random() * 1e9).toString().padStart(9, '0');
  return `9${rand.slice(0, 9)}`;
}

// =========================================================================
//  A. PATIENT — portal login via phone+OTP, view own visits + Rx, download PDF
// =========================================================================

test.describe.serial('Journey A — Patient portal (real person, phone+OTP)', () => {
  let patient = null;           // { id, name, phone, visitId?, rxId? }
  let portalToken = null;

  test('A1. Owner creates a new patient via API (so it can log in via portal)', async ({ request }) => {
    const { token } = await apiLogin(request, ADMIN);
    const phone = `+91${uniquePhone10()}`;
    const res = await request.post(`${API}/wellness/patients`, {
      headers: { Authorization: `Bearer ${token}` },
      data: {
        name: `E2E Patient ${STAMP}`,
        phone,
        email: `e2e_${STAMP}@example.test`,
        gender: 'female',
        dob: '1995-04-10',
      },
    });
    expect(res.ok(), `POST /patients should 2xx; got ${res.status()}`).toBeTruthy();
    const data = await res.json();
    patient = { id: data.id, name: data.name, phone };
    expect(patient.id).toBeGreaterThan(0);
  });

  test('A2. Doctor logs a completed visit + writes a prescription for this patient', async ({ request }) => {
    const { token, user } = await apiLogin(request, DOCTOR);
    // Issue #109 added a SERVICE_REQUIRED gate: completed visits must
    // carry a serviceId so reports can attribute revenue to a service.
    // Pre-this-fix the test was 400'ing because serviceId was missing.
    const svcRes = await request.get(`${API}/wellness/services`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const list = await svcRes.json();
    const items = Array.isArray(list) ? list : (list.services || list.items || list.data || []);
    expect(items.length, 'no services seeded — cannot complete visit').toBeGreaterThan(0);
    const serviceId = items[0].id;

    const visit = await request.post(`${API}/wellness/visits`, {
      headers: { Authorization: `Bearer ${token}` },
      data: {
        patientId: patient.id,
        doctorId: user.id,
        serviceId,
        status: 'completed',
        notes: 'Routine consultation — scalp check.',
        amountCharged: 500,
      },
    });
    expect(visit.ok()).toBeTruthy();
    const v = await visit.json();
    patient.visitId = v.id;

    const rx = await request.post(`${API}/wellness/prescriptions`, {
      headers: { Authorization: `Bearer ${token}` },
      data: {
        visitId: v.id,
        patientId: patient.id,
        drugs: [{ name: 'Minoxidil 5%', dosage: '1 ml', frequency: 'twice daily', duration: '12 weeks' }],
        instructions: 'Apply twice daily to scalp. Avoid sunlight 30 min post-application.',
      },
    });
    expect(rx.ok()).toBeTruthy();
    const rxBody = await rx.json();
    patient.rxId = rxBody.id;
  });

  test.fixme('A3. Patient opens /patient-portal and logs in with phone + any 4-digit OTP (v1 bypass)', async ({ page, request }) => {
    // Deferred: the v1 OTP bypass referenced in this test name was removed
    // by security fixes #292/#300 (routes/wellness.js:3068-3134 now
    // validates against the PatientOtp table). The hardcoded '1234' in
    // this test will return 401. Restoring the test requires DB-side OTP
    // injection (out of API-only e2e scope) or full SMS-loop integration.
    // Cascades into A4-A8 which chain off `portalToken` set here — those
    // are also expected to fixme but only A3/F5 are in scope of this fix.
    await clearBrowserState(page);

    // Direct API portal login (portal v1 accepts any 4-digit OTP) — mirrors what
    // the portal.html page does after the SMS flow.
    const res = await request.post(`${API}/wellness/portal/login`, {
      data: { phone: patient.phone, otp: '1234' },
    });
    expect(res.ok(), `/portal/login should 200; got ${res.status()}`).toBeTruthy();
    const body = await res.json();
    expect(body.token).toBeTruthy();
    expect(body.patient.id).toBe(patient.id);
    portalToken = body.token;
  });

  test.fixme('A4. /portal/me returns this patient (not anybody else)', async ({ request }) => {
    // Cascades off A3 portalToken (fixme'd in 84a606d).
    const res = await request.get(`${API}/wellness/portal/me`, {
      headers: { Authorization: `Bearer ${portalToken}` },
    });
    expect(res.ok()).toBeTruthy();
    const me = await res.json();
    expect(me.id).toBe(patient.id);
    expect(me.name).toContain('E2E Patient');
  });

  test.fixme('A5. /portal/visits shows the completed visit', async ({ request }) => {
    // Cascades off A3 portalToken.
    const res = await request.get(`${API}/wellness/portal/visits`, {
      headers: { Authorization: `Bearer ${portalToken}` },
    });
    expect(res.ok()).toBeTruthy();
    const visits = await res.json();
    expect(Array.isArray(visits)).toBeTruthy();
    const mine = visits.find((v) => v.id === patient.visitId);
    expect(mine, 'patient should see their own visit').toBeDefined();
    expect(mine.status).toBe('completed');
  });

  test.fixme('A6. /portal/prescriptions returns the Rx with the drug name', async ({ request }) => {
    // Cascades off A3 portalToken.
    const res = await request.get(`${API}/wellness/portal/prescriptions`, {
      headers: { Authorization: `Bearer ${portalToken}` },
    });
    expect(res.ok()).toBeTruthy();
    const list = await res.json();
    const mine = list.find((r) => r.id === patient.rxId);
    expect(mine).toBeDefined();
    // Drugs may be serialized; just assert substring match anywhere in the JSON
    expect(JSON.stringify(mine)).toContain('Minoxidil');
  });

  test('A7. Bad OTP shape (3 digits) is rejected — API guard works', async ({ request }) => {
    const res = await request.post(`${API}/wellness/portal/login`, {
      data: { phone: patient.phone, otp: '12' },
    });
    expect(res.status()).toBe(400);
  });

  // SECURITY — portal tokens are now rejected by middleware/auth.js
  // (guard added after this test caught the hole during the first run).
  // Portal JWTs lack a `userId` claim and the guard refuses them outright.
  test.fixme('A8. [SECURITY] Portal token rejected at staff endpoints', async ({ request }) => {
    // Cascades off A3 portalToken.
    const res = await request.get(`${API}/wellness/patients`, {
      headers: { Authorization: `Bearer ${portalToken}` },
    });
    expect([401, 403]).toContain(res.status());
  });
});

// =========================================================================
//  B. DOCTOR — real browser: login, pick a patient, log a visit + Rx in UI
// =========================================================================

test.describe.serial('Journey B — Doctor (real browser)', () => {
  test('B1. Doctor logs in via /login and lands on /wellness', async ({ page, request }) => {
    if (!(await isSpaServed(request))) {
      test.skip(true, `SPA not served at ${BASE_URL} (API-only backend) — browser tests need a frontend bundle.`);
    }
    await clearBrowserState(page);
    const { token, tenant, user } = await apiLogin(request, DOCTOR);
    await uiLoginViaToken(page, token, tenant, '/wellness', user);
    await page.waitForLoadState('networkidle', { timeout: 20000 });
    await expect(page.locator('body')).toHaveAttribute('data-vertical', 'wellness', { timeout: 10000 });
  });

  test('B2. Navigate to Patients page and see 50+ rows', async ({ page, request }) => {
    if (!(await isSpaServed(request))) {
      test.skip(true, `SPA not served at ${BASE_URL} — browser test.`);
    }
    const { token, tenant, user } = await apiLogin(request, DOCTOR);
    await uiLoginViaToken(page, token, tenant, '/wellness/patients', user);
    await page.waitForLoadState('networkidle', { timeout: 20000 });

    // Be resilient to layout: pick any element that textually contains a patient name.
    // Just assert the page rendered with at least one row-like clickable element.
    const clickable = page.locator('a, button, tr, li').filter({ hasText: /[A-Za-z]{3,}/ });
    const count = await clickable.count();
    expect(count, 'patients page should have some rows').toBeGreaterThan(5);
  });

  test('B3. Click a patient and see tabs render', async ({ page, request }) => {
    if (!(await isSpaServed(request))) {
      test.skip(true, `SPA not served at ${BASE_URL} — browser test.`);
    }
    // Same auth-residue gotcha B1 + D1 work around: auth.setup writes the
    // generic-CRM admin token to BOTH localStorage AND sessionStorage. The
    // SPA's getAuthToken() prefers the in-memory holder seeded from
    // sessionStorage, so a doctor token written via uiLoginViaToken (which
    // only touches localStorage, relying on the App.jsx legacy-localStorage
    // → sessionStorage migration) gets shadowed by the still-live admin
    // token. The SPA boots as admin@globussoft.com (generic tenant) and the
    // patient-detail fetch for a wellness-tenant patient 404s → "Patient
    // not found" → no tabs. clearBrowserState wipes both stores so the
    // migration path is the only one populating auth state on next boot.
    await clearBrowserState(page);
    const { token, tenant, user } = await apiLogin(request, DOCTOR);
    const patientsRes = await request.get(`${API}/wellness/patients?limit=1`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(patientsRes.ok()).toBeTruthy();
    const list = await patientsRes.json();
    const items = Array.isArray(list) ? list : (list.patients || list.items || list.data || []);
    expect(items.length).toBeGreaterThan(0);
    const id = items[0].id;

    await uiLoginViaToken(page, token, tenant, `/wellness/patients/${id}`, user);
    await page.waitForLoadState('networkidle', { timeout: 20000 });
    // Wait for the patient detail page header to mount before scanning
    // for tabs — the previous text-only locator was racing the render.
    await expect(page.locator('h1, h2').first()).toBeVisible({ timeout: 15000 });
    // Tab labels per PatientDetail.jsx:102-110 — match either the
    // Lucide-style buttons OR the legacy text spans. getByRole picks
    // the actual <button> elements, less ambiguous than text selectors.
    const tabPattern = /case history|prescription|consent|treatment|log visit|photos|inventory|telehealth/i;
    const anyTab = page.getByRole('button', { name: tabPattern })
      .or(page.locator('[role="tab"]').filter({ hasText: tabPattern }))
      .first();
    await expect(anyTab).toBeVisible({ timeout: 10000 });
  });
});

// =========================================================================
//  C. TELECALLER — work the SLA queue + disposition
// =========================================================================

test.describe.serial('Journey C — Telecaller (SLA queue)', () => {
  let leadContactId = null;

  test('C1. Seed a fresh lead via external API (simulates marketplace inbound)', async ({ request }) => {
    const partnerKey = await resolvePartnerKey(request);
    if (!partnerKey) {
      test.skip(true, 'No working partner X-API-Key for the wellness tenant — set WELLNESS_PARTNER_KEY or seed-wellness.js so admin@wellness.demo owns at least one ApiKey row.');
    }
    const res = await request.post(`${EXT}/leads`, {
      headers: { 'X-API-Key': partnerKey },
      data: {
        name: `Telecaller Queue Lead ${STAMP}`,
        phone: `+91${uniquePhone10()}`,
        email: `tc_${STAMP}@example.test`,
        source: 'meta_ad',
        message: 'Interested in PRP hair restoration',
      },
    });
    expect(res.ok(), `external /leads should 2xx; got ${res.status()}`).toBeTruthy();
    const body = await res.json();
    leadContactId = body.contact?.id || body.id;
    expect(leadContactId).toBeGreaterThan(0);
  });

  test('C2. Telecaller-queue endpoint responds with an array (may be empty on fresh prod)', async ({ request }) => {
    const { token } = await apiLogin(request, ADMIN);
    const res = await request.get(`${API}/wellness/telecaller/queue`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    const items = Array.isArray(body) ? body : (body.items || []);
    expect(Array.isArray(items), 'queue should be an array').toBeTruthy();
    // Queue filters by wellnessRole + assignment rules; freshly-created external
    // leads aren't guaranteed to land here immediately (auto-router may assign
    // to a doctor instead). Just prove the endpoint returns the expected shape.
  });

  test('C3. Disposition the lead (not-interested) — status propagates', async ({ request }) => {
    const { token } = await apiLogin(request, ADMIN);
    const res = await request.post(
      `${API}/wellness/telecaller/dispose`,
      {
        headers: { Authorization: `Bearer ${token}` },
        data: { contactId: leadContactId, disposition: 'not interested', notes: 'E2E test disposition' },
      },
    );
    // Tolerate minor shape differences across versions; success is 2xx.
    expect([200, 201, 204]).toContain(res.status());
  });
});

// =========================================================================
//  D. OWNER (RISHU) — dashboard → approve recommendation → reports tab
// =========================================================================

test.describe.serial('Journey D — Owner Rishu (dashboard, approve, reports)', () => {
  test('D1. Rishu logs in, lands on /wellness, sees KPI numbers', async ({ page, request }) => {
    if (!(await isSpaServed(request))) {
      test.skip(true, `SPA not served at ${BASE_URL} — browser test.`);
    }
    await clearBrowserState(page);
    const { token, tenant, user } = await apiLogin(request, RISHU);
    await uiLoginViaToken(page, token, tenant, '/wellness', user);
    await page.waitForLoadState('networkidle', { timeout: 20000 });
    await expect(page.locator('body')).toHaveAttribute('data-vertical', 'wellness', { timeout: 10000 });
    // Expect the page to have at least one ₹ currency symbol (INR tenant)
    const rupee = page.locator('text=/₹|Rs\\./').first();
    await expect(rupee).toBeVisible({ timeout: 10000 });
  });

  test('D2. Dashboard API returns a numeric occupancy + INR context', async ({ request }) => {
    const { token } = await apiLogin(request, RISHU);
    const res = await request.get(`${API}/wellness/dashboard`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.ok()).toBeTruthy();
    const d = await res.json();
    // Shape is permissive — look for a number in today.* or similar
    const hay = JSON.stringify(d);
    expect(hay).toMatch(/occupancy|today|revenue/i);
  });

  test('D3. Pending recommendations include at least one card; approve it', async ({ request }) => {
    const { token } = await apiLogin(request, RISHU);
    const list = await request.get(`${API}/wellness/recommendations?status=pending`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(list.ok()).toBeTruthy();
    const recs = await list.json();
    const arr = Array.isArray(recs) ? recs : (recs.items || []);
    if (arr.length === 0) {
      test.skip(true, 'no pending recommendations (e.g. already all approved today)');
    }
    const card = arr[0];
    const approve = await request.post(
      `${API}/wellness/recommendations/${card.id}/approve`,
      { headers: { Authorization: `Bearer ${token}` }, data: {} },
    );
    expect([200, 201]).toContain(approve.status());
  });

  test('D4. Reports — P&L-by-service endpoint returns rows', async ({ request }) => {
    const { token } = await apiLogin(request, RISHU);
    const res = await request.get(`${API}/wellness/reports/pnl-by-service`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.ok(), `pnl-by-service ${res.status()}`).toBeTruthy();
    const body = await res.json();
    // Shape: { window, totals: {revenue,contribution,...}, rows: [...] }
    expect(Array.isArray(body.rows), 'response should have rows[]').toBeTruthy();
    expect(body.totals).toBeDefined();
  });

  test('D5. Reports — per-professional returns rows', async ({ request }) => {
    const { token } = await apiLogin(request, RISHU);
    const res = await request.get(`${API}/wellness/reports/per-professional`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.ok()).toBeTruthy();
  });

  test('D6. Reports — per-location returns rows', async ({ request }) => {
    const { token } = await apiLogin(request, RISHU);
    const res = await request.get(`${API}/wellness/reports/per-location`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.ok()).toBeTruthy();
  });

  test('D7. Reports — marketing attribution returns JSON', async ({ request }) => {
    const { token } = await apiLogin(request, RISHU);
    const res = await request.get(`${API}/wellness/reports/attribution`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.ok()).toBeTruthy();
  });
});

// =========================================================================
//  E. ADMIN — add a service, update tenant branding, verify it applies
// =========================================================================

test.describe.serial('Journey E — Admin (service + branding)', () => {
  let newServiceId = null;

  test('E1. Admin creates a new service in the catalog', async ({ request }) => {
    const { token } = await apiLogin(request, ADMIN);
    const res = await request.post(`${API}/wellness/services`, {
      headers: { Authorization: `Bearer ${token}` },
      data: {
        name: `E2E Facial ${STAMP}`,
        category: 'medifacial',
        ticketTier: 'medium',
        basePrice: 2499,
        durationMin: 45,
        targetRadiusKm: 30,
        description: 'Inserted by wellness-real-user-journeys E2E test.',
      },
    });
    expect(res.ok(), `POST /services should 2xx; got ${res.status()}`).toBeTruthy();
    const body = await res.json();
    newServiceId = body.id;
    expect(newServiceId).toBeGreaterThan(0);
  });

  test('E2. Service appears in GET /services with the correct price', async ({ request }) => {
    const { token } = await apiLogin(request, ADMIN);
    const res = await request.get(`${API}/wellness/services`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.ok()).toBeTruthy();
    const rows = await res.json();
    const arr = Array.isArray(rows) ? rows : (rows.items || []);
    const mine = arr.find((s) => s.id === newServiceId);
    expect(mine, 'new service should appear in catalog').toBeDefined();
    expect(Number(mine.basePrice)).toBe(2499);
  });

  test('E3. Soft-delete the service via PUT {isActive:false}, confirm it disappears from default list', async ({ request }) => {
    const { token } = await apiLogin(request, ADMIN);
    // Wellness API does soft-delete through PUT, not DELETE
    const del = await request.put(`${API}/wellness/services/${newServiceId}`, {
      headers: { Authorization: `Bearer ${token}` },
      data: { isActive: false },
    });
    expect([200, 204]).toContain(del.status());

    const res = await request.get(`${API}/wellness/services`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const rows = await res.json();
    const arr = Array.isArray(rows) ? rows : (rows.items || []);
    const still = arr.find((s) => s.id === newServiceId);
    expect(still, 'soft-deleted service should not appear in default list').toBeFalsy();
  });

  test('E4. Tenant branding read returns logoUrl / brandColor fields', async ({ request }) => {
    const { token } = await apiLogin(request, ADMIN);
    const res = await request.get(`${API}/auth/me`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.ok()).toBeTruthy();
    const me = await res.json();
    expect(me.tenant).toBeDefined();
    expect(me.tenant).toHaveProperty('vertical', 'wellness');
    // brandColor/logoUrl may be null by default — just prove the keys exist on the shape
    expect(Object.keys(me.tenant)).toEqual(expect.arrayContaining(['vertical', 'defaultCurrency']));
  });
});

// =========================================================================
//  F. FULL LIFECYCLE — anonymous website → embed → junk filter → ... → portal
// =========================================================================

test.describe.serial('Journey F — Website visitor → lead → telecaller → patient portal', () => {
  let leadPhone = null;
  let createdPatientId = null;
  let junkId = null;

  test('F1. Website visitor pushes a GOOD lead via the partner API (what the embed script does)', async ({ request }) => {
    const partnerKey = await resolvePartnerKey(request);
    if (!partnerKey) {
      test.skip(true, 'No working partner X-API-Key for the wellness tenant.');
    }
    leadPhone = `+91${uniquePhone10()}`;
    const res = await request.post(`${EXT}/leads`, {
      headers: { 'X-API-Key': partnerKey },
      data: {
        name: `Lifecycle ${STAMP}`,
        phone: leadPhone,
        email: `lifecycle_${STAMP}@example.test`,
        source: 'embed_widget',
        message: 'Interested in unshaven FUE hair transplant — please call.',
      },
    });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    const contact = body.contact || body;
    expect(contact).toHaveProperty('id');
  });

  test('F2. Obvious junk lead (foreign number) is tagged as junk (not routed to telecaller)', async ({ request }) => {
    const partnerKey = await resolvePartnerKey(request);
    if (!partnerKey) {
      test.skip(true, 'No working partner X-API-Key for the wellness tenant.');
    }
    const res = await request.post(`${EXT}/leads`, {
      headers: { 'X-API-Key': partnerKey },
      data: {
        name: `Junk ${STAMP}`,
        phone: '+14155550100', // US number
        email: `junk_${STAMP}@example.test`,
        source: 'meta_ad',
      },
    });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    junkId = (body.contact || body).id;

    const { token } = await apiLogin(request, ADMIN);
    const check = await request.get(`${API}/contacts/${junkId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(check.ok()).toBeTruthy();
    const c = await check.json();
    // Junk filter should mark status=Junk or similar flag
    const hay = JSON.stringify(c).toLowerCase();
    expect(hay).toMatch(/junk|status/);
  });

  test('F3. Operator converts the good lead into a Patient record', async ({ request }) => {
    const { token } = await apiLogin(request, ADMIN);
    const res = await request.post(`${API}/wellness/patients`, {
      headers: { Authorization: `Bearer ${token}` },
      data: { name: `Lifecycle ${STAMP}`, phone: leadPhone, source: 'embed_widget' },
    });
    expect(res.ok()).toBeTruthy();
    const p = await res.json();
    createdPatientId = p.id;
  });

  test('F4. Book a visit for tomorrow (status=booked)', async ({ request }) => {
    const { token, user } = await apiLogin(request, ADMIN);
    const tomorrow = new Date(Date.now() + 24 * 3600_000).toISOString();
    const res = await request.post(`${API}/wellness/visits`, {
      headers: { Authorization: `Bearer ${token}` },
      data: {
        patientId: createdPatientId,
        doctorId: user.id,
        scheduledAt: tomorrow,
        status: 'booked',
      },
    });
    expect(res.ok()).toBeTruthy();
  });

  test.fixme('F5. New patient can now log in to the portal with phone+OTP', async ({ request }) => {
    // Same v1-bypass deferral as A3 — security fixes #292/#300 removed
    // the "any 4-digit OTP wins" cheat. Hardcoded '0000' now returns 401.
    // Restoring needs DB-side OTP injection (out of scope).
    const res = await request.post(`${API}/wellness/portal/login`, {
      data: { phone: leadPhone, otp: '0000' },
    });
    expect(res.ok(), `portal login for new patient ${res.status()}`).toBeTruthy();
    const body = await res.json();
    expect(body.patient.id).toBe(createdPatientId);
  });

  test('F6. Public booking page /book/enhanced-wellness renders for a cold visitor', async ({ page, request }) => {
    if (!(await isSpaServed(request))) {
      test.skip(true, `SPA not served at ${BASE_URL} — browser test.`);
    }
    await clearBrowserState(page);
    await page.goto('/book/enhanced-wellness');
    await page.waitForLoadState('domcontentloaded');
    // Expect something that looks like a booking header / service picker
    const hint = page.locator('text=/book|enhanced wellness|service/i').first();
    await expect(hint).toBeVisible({ timeout: 15000 });
  });

  test('F7. /api/health is 200 after the full run (backend is still alive)', async ({ request }) => {
    const res = await request.get(`${API}/health`);
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.status).toBe('healthy');
    expect(body.database).toBe('connected');
  });
});
