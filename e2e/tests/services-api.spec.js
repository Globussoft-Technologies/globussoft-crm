// @ts-check
/**
 * Wellness service catalog regression — per-push gate spec.
 *
 * Closes regression-coverage-backlog item #13 — pins five closed issues
 * (#115, #161, #209, #274, #364) that previously had no per-push regression
 * coverage. The next time someone refactors POST /api/wellness/services or
 * PUT /api/wellness/services/:id, any of these contracts breaking goes RED
 * at the gate, not on demo a week later.
 *
 * Bug class covered (each test pinned to a specific closed issue so the
 * git-blame trail is obvious if a regression lands):
 *
 *   #115 — POST rejects basePrice <= 0 with 400 PRICE_REQUIRED. Pre-fix the
 *          New Service form silently accepted 0 / negative prices and the
 *          row showed up on the public booking page priced "Free" — the
 *          owner had no idea until customers booked free hair-transplants.
 *          Same guard on PUT (covered by #274 pin below — silent-403 was
 *          actually a 403 with an unstructured-feeling body to the UI).
 *
 *   #161 — POST rejects durationMin <= 0 with 400 DURATION_INVALID. Pre-fix
 *          the form accepted negative durations; the calendar then drew the
 *          appointment as a 0-px-tall block. Same guard on PUT.
 *
 *   #209 — POST rejects basePrice > ₹50,00,000 (5_000_000) with 400
 *          PRICE_TOO_HIGH and durationMin > 720 (12h) with 400
 *          DURATION_TOO_HIGH. Pre-fix the catalog had a "Z" service with
 *          basePrice 1e15 and durationMin 999999 because there was no upper
 *          bound. The acceptance language in the backlog reads "price > 1e7
 *          and duration > 1440" — both are well above the actual 5M / 720
 *          cap, so the test sends values comfortably above the cap (1e8 for
 *          price, 1441 for duration) and asserts the rejection. If the cap
 *          is ever loosened beyond 1e8 / 1441, this spec catches it.
 *
 *   #274 — PUT /services/:id returns 4xx with a STRUCTURED error body, NOT
 *          a "silent" 403. The original report was "doctor clicked Save,
 *          nothing happened" — the network panel showed PUT → 403 but the
 *          response body had no actionable shape for the frontend to surface
 *          a toast. Today the response is `{error, code, allowed}` for
 *          WELLNESS_ROLE_FORBIDDEN and `{error, code}` for the validation
 *          errors. This pin asserts the body has BOTH `error` (human string)
 *          AND `code` (machine-readable identifier) on every 4xx — a
 *          regression that drops `code` would re-open #274 because the
 *          frontend's toast mapper keys off the code.
 *
 *   #364 — Tier dropdown discoverability (originally a UI-only P3 about
 *          missing tooltips for LOW/MED/HIGH). The API contract pin here:
 *          POST accepts `ticketTier` ∈ {low, medium, high} and stores it
 *          verbatim. Pre-fix the API silently coerced unknown values to
 *          "medium" without warning; today the route stores whatever the
 *          client sends (no validation), so the pin is "create + read-back
 *          preserves the tier value". A future fix that adds enum
 *          validation should still pass this test (low/medium/high are
 *          valid); a future regression that drops the field would fail.
 *
 * Why this spec exists alongside wellness-clinical-api.spec.js:
 *   • wellness-clinical-api covers the BROAD CRUD surface — happy paths
 *     for admin + manager creates, basic validation on each branch. It's
 *     part of the wide coverage push for routes/wellness.js.
 *   • This spec is REGRESSION-FOCUSED: revert-and-prove discipline (each
 *     pin maps to a specific issue number + a specific bug shape that has
 *     happened in the past). It's narrower, deeper, and explicit about WHY
 *     each test exists. Same discipline as public-booking-api.spec.js
 *     (commit c1c6075) and auth-security-regression-api.spec.js (commit
 *     db543af).
 *
 * Endpoints covered:
 *   GET  /api/wellness/services                — tenant isolation pin
 *   POST /api/wellness/services                — validation matrix + RBAC + happy path
 *   PUT  /api/wellness/services/:id            — validation matrix + RBAC + structured-error
 *
 * Status-code + error-key contracts (pinned in this spec):
 *   POST /services
 *     201 + svc body                — admin/manager with valid input
 *     400 {error, code: PRICE_REQUIRED}     — basePrice <= 0
 *     400 {error, code: PRICE_TOO_HIGH}     — basePrice > 5_000_000
 *     400 {error, code: DURATION_INVALID}   — durationMin <= 0
 *     400 {error, code: DURATION_TOO_HIGH}  — durationMin > 720
 *     400 {error: 'name required'}          — name missing/blank (no code today)
 *     403 {error, code: WELLNESS_ROLE_FORBIDDEN, allowed} — doctor/professional/telecaller/helper
 *     403 {error, code: WELLNESS_TENANT_REQUIRED}         — generic-tenant admin
 *   PUT /services/:id
 *     200 + svc body                — admin/manager with valid input
 *     400 {error, code: PRICE_REQUIRED}     — same as POST
 *     400 {error, code: PRICE_TOO_HIGH}     — same as POST
 *     400 {error, code: DURATION_INVALID}   — same as POST
 *     400 {error, code: DURATION_TOO_HIGH}  — same as POST
 *     403 {error, code: WELLNESS_ROLE_FORBIDDEN, allowed} — same RBAC matrix
 *     404 {error}                  — unknown id
 *
 * Persona table (seeded by prisma/seed-wellness.js):
 *   admin@wellness.demo            — RBAC ADMIN, no wellnessRole (passes admin gate)
 *   manager@enhancedwellness.in    — RBAC MANAGER, no wellnessRole (passes manager gate)
 *   drharsh@enhancedwellness.in    — wellnessRole=doctor (denied — clinical, not catalog)
 *   stylist1@enhancedwellness.in   — wellnessRole=professional (denied)
 *   telecaller@enhancedwellness.in — wellnessRole=telecaller (denied)
 *   helper1@enhancedwellness.in    — wellnessRole=helper (denied)
 *   admin@globussoft.com           — generic-tenant ADMIN (denied — wrong vertical)
 *
 * RUN_TAG: `E2E_SVC_<ts>` — registered in e2e/test-data-patterns.js so
 * global-teardown's REGEXP scrub catches stragglers. Since `Service` has
 * no DELETE endpoint, afterAll soft-disables created rows via
 * PUT { isActive: false } so they vanish from list/public endpoints.
 *
 * stripDangerous reminder: the global middleware deletes
 * `id, createdAt, updatedAt, tenantId, userId, isAdmin, passwordHash,
 * portalPasswordHash` from every request body. None of those are referenced
 * here — service POSTs are name/category/ticketTier/basePrice/durationMin/
 * targetRadiusKm/description-shaped only.
 *
 * Test environment expectations:
 *   - BASE_URL pointing at a backend with wellness routes mounted. Per-push
 *     gate: http://127.0.0.1:5000 (CI). Local stack: same. e2e-full:
 *     https://crm.globusdemos.com.
 *   - Both tenants seeded (prisma/seed.js + prisma/seed-wellness.js). The
 *     cross-vertical test relies on admin@globussoft.com existing.
 *
 * Revert-and-prove (P1 acceptance from regression-coverage-backlog.md):
 *   1. Delete the `if (price <= 0) return 400 PRICE_REQUIRED` guard in
 *      routes/wellness.js POST /services
 *      → "POST basePrice=0 → 400 PRICE_REQUIRED" goes RED (#115 pin)
 *   2. Delete the `if (d > 720) return 400 DURATION_TOO_HIGH` guard
 *      → "POST durationMin=1441 → 400 DURATION_TOO_HIGH" goes RED (#209 pin)
 *   3. Drop the `code` field from the PUT 403 response
 *      → "PUT as doctor → 403 with structured body" goes RED (#274 pin)
 *   4. Restore each → all tests GREEN.
 */
const { test, expect } = require('@playwright/test');

// Several tests below mutate created rows and read them back. Pin to serial
// to avoid worker-shuffle races, mirroring wellness-clinical-api.spec.js.
test.describe.configure({ mode: 'serial' });

const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:5000';
const API = `${BASE_URL}/api`;
const REQUEST_TIMEOUT = 60000;
const RUN_TAG = `E2E_SVC_${Date.now()}`;

// ── Fixtures ───────────────────────────────────────────────────────
const FIXTURES = {
  admin:      { email: 'admin@wellness.demo',            password: 'password123' },
  manager:    { email: 'manager@enhancedwellness.in',    password: 'password123' },
  drharsh:    { email: 'drharsh@enhancedwellness.in',    password: 'password123' },
  stylist:    { email: 'stylist1@enhancedwellness.in',   password: 'password123' },
  telecaller: { email: 'telecaller@enhancedwellness.in', password: 'password123' },
  helper:     { email: 'helper1@enhancedwellness.in',    password: 'password123' },
  generic:    { email: 'admin@globussoft.com',           password: 'password123' },
};

const tokenCache = {};

async function login(request, who) {
  if (tokenCache[who]) return tokenCache[who];
  const fixture = FIXTURES[who];
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await request.post(`${API}/auth/login`, {
        data: fixture,
        headers: { 'Content-Type': 'application/json' },
        timeout: REQUEST_TIMEOUT,
      });
      if (r.ok()) {
        const data = await r.json();
        tokenCache[who] = data.token;
        return data.token;
      }
    } catch (_e) {
      if (attempt === 0) continue;
    }
  }
  return null;
}

const authHdr = async (request, who = 'admin') => ({
  Authorization: `Bearer ${await login(request, who)}`,
  'Content-Type': 'application/json',
});

async function authGet(request, path, who = 'admin') {
  return request.get(`${API}${path}`, {
    headers: await authHdr(request, who),
    timeout: REQUEST_TIMEOUT,
  });
}
async function authPost(request, path, body, who = 'admin') {
  return request.post(`${API}${path}`, {
    headers: await authHdr(request, who),
    data: body ?? {},
    timeout: REQUEST_TIMEOUT,
  });
}
async function authPut(request, path, body, who = 'admin') {
  return request.put(`${API}${path}`, {
    headers: await authHdr(request, who),
    data: body ?? {},
    timeout: REQUEST_TIMEOUT,
  });
}

// Track every Service we create so afterAll can soft-disable them.
const createdServiceIds = [];

test.afterAll(async ({ request }) => {
  if (!tokenCache.admin) return;
  for (const id of createdServiceIds) {
    // Service has no DELETE endpoint. PUT isActive=false hides it from list
    // + public booking; the row stays in DB but is invisible. Combined with
    // the RUN_TAG name prefix, global-teardown's regex sweep will catch it
    // on the demo-monitor cron pass. Same shape as wellness-clinical-api's
    // service cleanup (e2e/tests/wellness-clinical-api.spec.js:167).
    await authPut(request, `/wellness/services/${id}`, { isActive: false }).catch(() => {});
  }
});

// ──────────────────────────────────────────────────────────────────────
// #115 — POST/PUT reject basePrice <= 0 with 400 PRICE_REQUIRED
// ──────────────────────────────────────────────────────────────────────

test.describe('#115 — basePrice <= 0 rejected', () => {
  test('POST basePrice=0 → 400 PRICE_REQUIRED', async ({ request }) => {
    const r = await authPost(request, '/wellness/services', {
      name: `${RUN_TAG} ZeroPrice`,
      basePrice: 0,
      durationMin: 30,
    });
    expect(r.status()).toBe(400);
    const body = await r.json();
    expect(body.code).toBe('PRICE_REQUIRED');
    expect(body.error).toBeTruthy(); // human-readable message present
  });

  test('POST basePrice=-100 → 400 PRICE_REQUIRED', async ({ request }) => {
    const r = await authPost(request, '/wellness/services', {
      name: `${RUN_TAG} NegPrice`,
      basePrice: -100,
      durationMin: 30,
    });
    expect(r.status()).toBe(400);
    expect((await r.json()).code).toBe('PRICE_REQUIRED');
  });

  test('POST basePrice="not-a-number" → 400 PRICE_REQUIRED (Number.isFinite gate)', async ({ request }) => {
    const r = await authPost(request, '/wellness/services', {
      name: `${RUN_TAG} NaNPrice`,
      basePrice: 'free',
      durationMin: 30,
    });
    expect(r.status()).toBe(400);
    expect((await r.json()).code).toBe('PRICE_REQUIRED');
  });

  test('PUT basePrice=0 → 400 PRICE_REQUIRED (same guard on edit)', async ({ request }) => {
    // Create a valid service then try to bump it to 0 via PUT.
    const created = await authPost(request, '/wellness/services', {
      name: `${RUN_TAG} EditToZero`,
      basePrice: 1000,
      durationMin: 60,
    });
    expect(created.status()).toBe(201);
    const sid = (await created.json()).id;
    createdServiceIds.push(sid);

    const r = await authPut(request, `/wellness/services/${sid}`, { basePrice: 0 });
    expect(r.status()).toBe(400);
    const body = await r.json();
    expect(body.code).toBe('PRICE_REQUIRED');
    expect(body.error).toBeTruthy();
  });
});

// ──────────────────────────────────────────────────────────────────────
// #161 — POST/PUT reject durationMin <= 0 with 400 DURATION_INVALID
// ──────────────────────────────────────────────────────────────────────

test.describe('#161 — durationMin <= 0 rejected', () => {
  test('POST durationMin=0 → 400 DURATION_INVALID', async ({ request }) => {
    const r = await authPost(request, '/wellness/services', {
      name: `${RUN_TAG} ZeroDur`,
      basePrice: 500,
      durationMin: 0,
    });
    expect(r.status()).toBe(400);
    const body = await r.json();
    expect(body.code).toBe('DURATION_INVALID');
    expect(body.error).toBeTruthy();
  });

  test('POST durationMin=-30 → 400 DURATION_INVALID', async ({ request }) => {
    const r = await authPost(request, '/wellness/services', {
      name: `${RUN_TAG} NegDur`,
      basePrice: 500,
      durationMin: -30,
    });
    expect(r.status()).toBe(400);
    expect((await r.json()).code).toBe('DURATION_INVALID');
  });

  test('PUT durationMin=-1 → 400 DURATION_INVALID (same guard on edit)', async ({ request }) => {
    const created = await authPost(request, '/wellness/services', {
      name: `${RUN_TAG} EditToNegDur`,
      basePrice: 500,
      durationMin: 30,
    });
    expect(created.status()).toBe(201);
    const sid = (await created.json()).id;
    createdServiceIds.push(sid);

    const r = await authPut(request, `/wellness/services/${sid}`, { durationMin: -1 });
    expect(r.status()).toBe(400);
    expect((await r.json()).code).toBe('DURATION_INVALID');
  });
});

// ──────────────────────────────────────────────────────────────────────
// #209 — POST/PUT reject basePrice > 5_000_000 and durationMin > 720
// ──────────────────────────────────────────────────────────────────────

test.describe('#209 — upper-bound caps on price + duration', () => {
  test('POST basePrice=5_000_001 (1 over cap) → 400 PRICE_TOO_HIGH', async ({ request }) => {
    const r = await authPost(request, '/wellness/services', {
      name: `${RUN_TAG} JustOverPrice`,
      basePrice: 5_000_001,
      durationMin: 60,
    });
    expect(r.status()).toBe(400);
    const body = await r.json();
    expect(body.code).toBe('PRICE_TOO_HIGH');
    expect(body.error).toBeTruthy();
  });

  test('POST basePrice=1e8 (acceptance value) → 400 PRICE_TOO_HIGH', async ({ request }) => {
    // Backlog acceptance language reads "price > 1e7"; the route's actual
    // cap is 5_000_000 (₹50L). 1e8 is well above either threshold so the
    // rejection holds whichever cap is in effect — gives us safety if the
    // cap is ever raised to exactly 1e7.
    const r = await authPost(request, '/wellness/services', {
      name: `${RUN_TAG} BigPrice1e8`,
      basePrice: 1e8,
      durationMin: 60,
    });
    expect(r.status()).toBe(400);
    expect((await r.json()).code).toBe('PRICE_TOO_HIGH');
  });

  test('POST durationMin=721 (1 over cap) → 400 DURATION_TOO_HIGH', async ({ request }) => {
    const r = await authPost(request, '/wellness/services', {
      name: `${RUN_TAG} JustOverDur`,
      basePrice: 500,
      durationMin: 721,
    });
    expect(r.status()).toBe(400);
    const body = await r.json();
    expect(body.code).toBe('DURATION_TOO_HIGH');
    expect(body.error).toBeTruthy();
  });

  test('POST durationMin=1441 (acceptance value, just over 24h) → 400 DURATION_TOO_HIGH', async ({ request }) => {
    // Backlog acceptance language reads "duration > 1440 (24h)"; the route's
    // actual cap is 720 (12h). 1441 is well above either threshold.
    const r = await authPost(request, '/wellness/services', {
      name: `${RUN_TAG} BigDur1441`,
      basePrice: 500,
      durationMin: 1441,
    });
    expect(r.status()).toBe(400);
    expect((await r.json()).code).toBe('DURATION_TOO_HIGH');
  });

  test('PUT basePrice=1e9 (cap not skipped on edit) → 400 PRICE_TOO_HIGH', async ({ request }) => {
    const created = await authPost(request, '/wellness/services', {
      name: `${RUN_TAG} EditToBigPrice`,
      basePrice: 1000,
      durationMin: 60,
    });
    expect(created.status()).toBe(201);
    const sid = (await created.json()).id;
    createdServiceIds.push(sid);

    const r = await authPut(request, `/wellness/services/${sid}`, { basePrice: 1e9 });
    expect(r.status()).toBe(400);
    expect((await r.json()).code).toBe('PRICE_TOO_HIGH');
  });

  test('PUT durationMin=10000 (cap not skipped on edit) → 400 DURATION_TOO_HIGH', async ({ request }) => {
    const created = await authPost(request, '/wellness/services', {
      name: `${RUN_TAG} EditToBigDur`,
      basePrice: 1000,
      durationMin: 60,
    });
    expect(created.status()).toBe(201);
    const sid = (await created.json()).id;
    createdServiceIds.push(sid);

    const r = await authPut(request, `/wellness/services/${sid}`, { durationMin: 10000 });
    expect(r.status()).toBe(400);
    expect((await r.json()).code).toBe('DURATION_TOO_HIGH');
  });
});

// ──────────────────────────────────────────────────────────────────────
// #274 — PUT returns STRUCTURED 4xx body (NOT silent 403)
// ──────────────────────────────────────────────────────────────────────

test.describe('#274 — PUT 4xx responses carry structured error body', () => {
  // The original bug was "doctor clicked Save, nothing happened". Network
  // showed PUT → 403 but the response body had no shape the frontend could
  // map to a toast. Today the body is `{error, code, allowed}` for the RBAC
  // 403 path and `{error, code}` for validation 400s. This describe block
  // asserts the SHAPE on every 4xx that PUT can return — a regression that
  // drops `code` re-opens #274 because the toast mapper keys off it.

  let svcId = null;

  test.beforeAll(async ({ request }) => {
    const created = await authPost(request, '/wellness/services', {
      name: `${RUN_TAG} StructuredErr`,
      basePrice: 1000,
      durationMin: 60,
    });
    expect(created.status()).toBe(201);
    svcId = (await created.json()).id;
    createdServiceIds.push(svcId);
  });

  test('PUT as doctor → 403 with {error, code: WELLNESS_ROLE_FORBIDDEN, allowed}', async ({ request }) => {
    test.skip(!svcId, 'service not created');
    const r = await authPut(request, `/wellness/services/${svcId}`, { basePrice: 2000 }, 'drharsh');
    expect(r.status()).toBe(403);
    const body = await r.json();
    // Three pinned keys — drop any of them and #274 re-opens.
    expect(body).toHaveProperty('error');
    expect(body).toHaveProperty('code');
    expect(body.code).toBe('WELLNESS_ROLE_FORBIDDEN');
    expect(body).toHaveProperty('allowed');
    expect(Array.isArray(body.allowed)).toBe(true);
    expect(body.allowed).toEqual(expect.arrayContaining(['admin', 'manager']));
    // Body must not be empty — the original bug was a 403 the frontend
    // couldn't act on. An empty body or `{}` would re-open #274.
    expect(Object.keys(body).length).toBeGreaterThan(0);
  });

  test('PUT as professional → 403 with structured body', async ({ request }) => {
    test.skip(!svcId, 'service not created');
    const r = await authPut(request, `/wellness/services/${svcId}`, { basePrice: 2000 }, 'stylist');
    expect(r.status()).toBe(403);
    const body = await r.json();
    expect(body.code).toBe('WELLNESS_ROLE_FORBIDDEN');
    expect(body.error).toBeTruthy();
  });

  test('PUT as telecaller → 403 with structured body', async ({ request }) => {
    test.skip(!svcId, 'service not created');
    const r = await authPut(request, `/wellness/services/${svcId}`, { basePrice: 2000 }, 'telecaller');
    expect(r.status()).toBe(403);
    const body = await r.json();
    expect(body.code).toBe('WELLNESS_ROLE_FORBIDDEN');
    expect(body.error).toBeTruthy();
  });

  test('PUT as helper → 403 with structured body', async ({ request }) => {
    test.skip(!svcId, 'service not created');
    const r = await authPut(request, `/wellness/services/${svcId}`, { basePrice: 2000 }, 'helper');
    expect(r.status()).toBe(403);
    const body = await r.json();
    expect(body.code).toBe('WELLNESS_ROLE_FORBIDDEN');
    expect(body.error).toBeTruthy();
  });

  test('PUT 404 (unknown id) carries structured body', async ({ request }) => {
    const r = await authPut(request, '/wellness/services/99999999', { basePrice: 500 });
    expect(r.status()).toBe(404);
    const body = await r.json();
    expect(body).toHaveProperty('error');
    expect(body.error).toBeTruthy();
  });

  test('PUT 400 validation (basePrice=0) carries structured body with code', async ({ request }) => {
    test.skip(!svcId, 'service not created');
    const r = await authPut(request, `/wellness/services/${svcId}`, { basePrice: 0 });
    expect(r.status()).toBe(400);
    const body = await r.json();
    expect(body).toHaveProperty('error');
    expect(body).toHaveProperty('code');
    expect(body.code).toBe('PRICE_REQUIRED');
  });
});

// ──────────────────────────────────────────────────────────────────────
// imageUrls round-trip — backend accepts array OR pre-stringified JSON,
// PUT can clear with null/empty. Added 2026-05-21 alongside the wellness
// service detail modal that displays the image gallery.
// ──────────────────────────────────────────────────────────────────────

test.describe('imageUrls field — accepted on POST + PUT, round-trips intact', () => {
  test('POST with imageUrls array stores it as a JSON-stringified array', async ({ request }) => {
    const urls = ['https://cdn.example.com/svc-a.png', 'https://cdn.example.com/svc-b.jpg'];
    const r = await authPost(request, '/wellness/services', {
      name: `${RUN_TAG} ImgArr`,
      basePrice: 1500,
      durationMin: 45,
      imageUrls: urls,
    }, 'admin');
    expect(r.status(), `POST: ${await r.text()}`).toBe(201);
    const body = await r.json();
    createdServiceIds.push(body.id);
    // The Prisma column stores a JSON-encoded array; the API echoes that
    // raw string back. Parse to confirm both URLs round-tripped.
    const parsed = JSON.parse(body.imageUrls);
    expect(parsed).toEqual(urls);
  });

  test('POST with pre-stringified imageUrls is stored verbatim', async ({ request }) => {
    const stringified = JSON.stringify(['https://cdn.example.com/svc-c.png']);
    const r = await authPost(request, '/wellness/services', {
      name: `${RUN_TAG} ImgStr`,
      basePrice: 1500,
      durationMin: 45,
      imageUrls: stringified,
    }, 'admin');
    expect(r.status()).toBe(201);
    const body = await r.json();
    createdServiceIds.push(body.id);
    expect(body.imageUrls).toBe(stringified);
  });

  test('PUT imageUrls: null clears the column', async ({ request }) => {
    // Seed a row with images, then null the column.
    const seed = await authPost(request, '/wellness/services', {
      name: `${RUN_TAG} ImgClear`,
      basePrice: 1500,
      durationMin: 45,
      imageUrls: ['https://cdn.example.com/x.png'],
    }, 'admin');
    const created = await seed.json();
    createdServiceIds.push(created.id);

    const upd = await authPut(request, `/wellness/services/${created.id}`, { imageUrls: null }, 'admin');
    expect(upd.status()).toBe(200);
    const body = await upd.json();
    expect(body.imageUrls).toBeNull();
  });
});

// ──────────────────────────────────────────────────────────────────────
// RBAC matrix — POST gate (admin/manager only)
// ──────────────────────────────────────────────────────────────────────

test.describe('RBAC: POST /services gated to admin + manager', () => {
  // Wave-2 #527 PHI gates locked catalog mutations to admin/manager —
  // clinical staff (doctors, professionals) read but don't define pricing.
  // Each denied role gets a structured WELLNESS_ROLE_FORBIDDEN body so the
  // frontend can render an actionable toast (per #274).

  test('admin → 201', async ({ request }) => {
    const r = await authPost(request, '/wellness/services', {
      name: `${RUN_TAG} AdminCreate`,
      basePrice: 1500,
      durationMin: 45,
    }, 'admin');
    expect(r.status()).toBe(201);
    const body = await r.json();
    expect(body.id).toEqual(expect.any(Number));
    expect(body.name).toContain(RUN_TAG);
    createdServiceIds.push(body.id);
  });

  test('manager → 201', async ({ request }) => {
    const r = await authPost(request, '/wellness/services', {
      name: `${RUN_TAG} ManagerCreate`,
      basePrice: 1500,
      durationMin: 45,
    }, 'manager');
    expect(r.status()).toBe(201);
    createdServiceIds.push((await r.json()).id);
  });

  for (const persona of ['drharsh', 'stylist', 'telecaller', 'helper']) {
    test(`${persona} → 403 WELLNESS_ROLE_FORBIDDEN`, async ({ request }) => {
      const r = await authPost(request, '/wellness/services', {
        name: `${RUN_TAG} ${persona} Create`,
        basePrice: 1500,
        durationMin: 45,
      }, persona);
      expect(r.status()).toBe(403);
      const body = await r.json();
      expect(body.code).toBe('WELLNESS_ROLE_FORBIDDEN');
      expect(body.error).toBeTruthy();
    });
  }

  test('generic-tenant admin → 403 WELLNESS_TENANT_REQUIRED (cross-vertical block, #325)', async ({ request }) => {
    // Pre-#325 a generic-tenant ADMIN could call wellness routes because
    // verifyWellnessRole only checked role===ADMIN, ignoring tenant.vertical.
    // Today the middleware refuses any non-wellness tenant up-front.
    const r = await authPost(request, '/wellness/services', {
      name: `${RUN_TAG} GenericCrossover`,
      basePrice: 1500,
      durationMin: 45,
    }, 'generic');
    expect(r.status()).toBe(403);
    const body = await r.json();
    expect(body.code).toBe('WELLNESS_TENANT_REQUIRED');
    expect(body.error).toBeTruthy();
  });
});

// ──────────────────────────────────────────────────────────────────────
// Tenant isolation — generic admin's GET /services is empty/their-tenant-only
// ──────────────────────────────────────────────────────────────────────

test.describe('Tenant isolation: GET /services is per-tenant', () => {
  // GET /services has NO role gate (read-only catalog) but DOES use
  // tenantWhere — the wellness-tenant's services should never appear in
  // a generic-tenant admin's response. Pre-tenantWhere any logged-in user
  // could see every tenant's catalog.

  test('wellness admin sees the just-created service in the list', async ({ request }) => {
    // Create a uniquely-named service then verify it shows up in admin's list.
    const created = await authPost(request, '/wellness/services', {
      name: `${RUN_TAG} IsolationProbe`,
      basePrice: 1234,
      durationMin: 60,
    }, 'admin');
    expect(created.status()).toBe(201);
    const svcId = (await created.json()).id;
    createdServiceIds.push(svcId);

    const list = await authGet(request, '/wellness/services', 'admin');
    expect(list.status()).toBe(200);
    const services = await list.json();
    const found = services.find((s) => s.id === svcId);
    expect(found, `wellness admin should see their just-created service ${svcId}`).toBeTruthy();
    expect(found.name).toBe(`${RUN_TAG} IsolationProbe`);
  });

  test('generic-tenant admin GET /services does NOT include wellness rows', async ({ request }) => {
    // GET has no role gate so generic admin gets a 200 — but the response
    // should only contain rows where tenantId === generic.tenantId. The
    // wellness-tagged probe row from the previous test must NOT appear.
    const r = await authGet(request, '/wellness/services', 'generic');
    expect(r.status()).toBe(200);
    const services = await r.json();
    expect(Array.isArray(services)).toBe(true);
    const leaked = services.filter((s) => String(s.name || '').startsWith(RUN_TAG));
    expect(
      leaked.map((s) => ({ id: s.id, name: s.name })),
      `tenant isolation broken — generic-tenant admin saw wellness-tenant services tagged ${RUN_TAG}`
    ).toEqual([]);
  });
});

// ──────────────────────────────────────────────────────────────────────
// #364 — ticketTier round-trip (LOW/MED/HIGH preserved on create)
// ──────────────────────────────────────────────────────────────────────

test.describe('#364 — ticketTier value preserved on create + read-back', () => {
  // The original report was UI-only (missing tooltip on the LOW/MED/HIGH
  // dropdown). The API contract pin: whatever tier the client sends is
  // stored verbatim. Today's seed uses lowercase ("low"/"medium"/"high");
  // the route stores whatever comes in, with default "medium".
  //
  // If a future regression coerces all tiers to "medium" silently (the
  // pre-#364 UI bug class), this test goes red.

  for (const tier of ['low', 'medium', 'high']) {
    test(`ticketTier="${tier}" round-trips`, async ({ request }) => {
      const created = await authPost(request, '/wellness/services', {
        name: `${RUN_TAG} Tier${tier}`,
        basePrice: 500,
        durationMin: 30,
        ticketTier: tier,
      });
      expect(created.status()).toBe(201);
      const body = await created.json();
      createdServiceIds.push(body.id);
      expect(body.ticketTier).toBe(tier);

      // Read it back via GET to confirm storage, not just response echo.
      const list = await authGet(request, '/wellness/services');
      expect(list.status()).toBe(200);
      const svc = (await list.json()).find((s) => s.id === body.id);
      expect(svc, `service ${body.id} not in list`).toBeTruthy();
      expect(svc.ticketTier).toBe(tier);
    });
  }

  test('omitted ticketTier defaults to "medium"', async ({ request }) => {
    const r = await authPost(request, '/wellness/services', {
      name: `${RUN_TAG} TierDefault`,
      basePrice: 500,
      durationMin: 30,
    });
    expect(r.status()).toBe(201);
    const body = await r.json();
    createdServiceIds.push(body.id);
    expect(body.ticketTier).toBe('medium');
  });
});

// ──────────────────────────────────────────────────────────────────────
// Happy-path — round-trip a service end-to-end
// ──────────────────────────────────────────────────────────────────────

test.describe('Happy path: create → read → update → soft-delete', () => {
  test('full lifecycle of a wellness service', async ({ request }) => {
    // Create
    const created = await authPost(request, '/wellness/services', {
      name: `${RUN_TAG} Lifecycle`,
      category: 'aesthetics',
      basePrice: 2500,
      durationMin: 90,
      description: 'Round-trip happy path probe',
    });
    expect(created.status(), await created.text()).toBe(201);
    const svc = await created.json();
    expect(svc.id).toEqual(expect.any(Number));
    expect(svc.name).toBe(`${RUN_TAG} Lifecycle`);
    expect(parseFloat(svc.basePrice)).toBe(2500);
    expect(svc.durationMin).toBe(90);
    expect(svc.isActive).toBe(true);
    createdServiceIds.push(svc.id);

    // Read in list
    const list = await authGet(request, '/wellness/services');
    expect(list.status()).toBe(200);
    const found = (await list.json()).find((s) => s.id === svc.id);
    expect(found).toBeTruthy();

    // Update price
    const updated = await authPut(request, `/wellness/services/${svc.id}`, {
      basePrice: 3000,
      description: 'Updated description',
    });
    expect(updated.status()).toBe(200);
    const updatedBody = await updated.json();
    expect(parseFloat(updatedBody.basePrice)).toBe(3000);
    expect(updatedBody.description).toBe('Updated description');

    // Soft-delete via PUT isActive=false (no DELETE endpoint exists)
    const disabled = await authPut(request, `/wellness/services/${svc.id}`, { isActive: false });
    expect(disabled.status()).toBe(200);

    // After disable, GET /services (which filters isActive=true) excludes it
    const afterDisable = await authGet(request, '/wellness/services');
    const stillVisible = (await afterDisable.json()).find((s) => s.id === svc.id);
    expect(stillVisible, 'soft-deleted service still visible in active list').toBeFalsy();
  });
});
