// @ts-check
/**
 * Public-booking + embed widget regression — per-push gate spec.
 *
 * Closes the regression-coverage-backlog item #14 (8 issues, all CLOSED but
 * previously had no per-push pin) → the next time someone refactors the
 * /api/wellness/public/* surface or the /embed widget, any of these
 * contracts breaking goes RED at gate, not in production.
 *
 * Bug class covered (each test is pinned to a specific closed issue so the
 * git-blame trail is obvious if a regression lands):
 *
 *   #208 — /portal serves the customer portal contract, NOT the wellness
 *          patient portal. The original bug was a frontend route collision
 *          (#208's "Support & Knowledge Base" page was rendering at /portal
 *          for wellness tenants); the fix moved the wellness portal to
 *          /wellness/portal. Backend pin: /api/portal/me requires the generic
 *          contact-portal token (`type: 'PORTAL'`) and rejects the wellness
 *          patient-portal JWT shape (`patientId` claim, no `type`). If the
 *          two routes collapse into one again, this pin goes red.
 *
 *   #218 — POST /api/wellness/services rejects price > cap and duration > cap.
 *          Pre-fix the catalog had an `{name: 'Z', basePrice: 1e20,
 *          durationMin: 999999}` row that crashed the public booking page.
 *          The fix added 5_000_000 cap on basePrice (#209) and 720-min cap
 *          on durationMin. Acceptance language asks for "price > 1e8 or
 *          duration > 1440" — both are well above the cap, so if the cap
 *          is removed/relaxed beyond 1e8 / 1440 those values would 201
 *          and this test would fail.
 *
 *   #219 — Public booking validation gates:
 *          (a) phone < 10 digits → 400 INVALID_PHONE (was 201)
 *          (b) date in the past → 400 SLOT_IN_PAST (was 201 with 1900-01-01)
 *          (c) date > 90 days out → 400 SLOT_TOO_FAR
 *              (acceptance writes "today + 365" but the route caps at 90 days
 *               per the inline comment; 365 is well past 90 so the assertion
 *               holds either way — what matters is "you can't book in 2030")
 *          (d) per-IP rate-limit headers are emitted (publicBookLimiter,
 *              max=10/minute by policy; in NODE_ENV=test the active ceiling
 *              is bumped so the header is present but the budget can't
 *              exhaust during the gate. Same shape as the auth-security
 *              spec's #295 OTP-limiter pin — assert wired, not 429.)
 *
 *   #279 — POST /public/book returns 201 ONLY when both Patient AND Visit rows
 *          are persisted. Pre-fix a path that auto-resolved a missing locationId
 *          could 201 with an orphan Patient + no Visit; the dashboard/calendar
 *          query would never see the booking → silent data loss. The fix
 *          wrapped patient + visit in a $transaction. Pin: after a 201,
 *          verify the visit is reachable in the wellness-tenant admin's
 *          GET /wellness/visits, scoped by phone last-10.
 *
 *   #283 — Tagged with #14 in the backlog; covered by the slug + service
 *          rejection tests (anything that surfaces as the "garbage row in
 *          public catalog" class).
 *
 *   #291 — Internal/dev location names ("smoke-test-…", "e2e-…", "test-…",
 *          "qa-…", "dev-…") are filtered from /api/wellness/public/tenant/:slug.
 *          Pin: any seeded internal-test location name does NOT appear in the
 *          public response.
 *
 *   #297 — /embed/lead-form.html returns 404 at GET time for invalid API keys
 *          rather than rendering a fully-functional form that only fails on
 *          submit. Pre-fix the static HTML loaded with 200 regardless of the
 *          ?key= value; bots probing /embed?key=garbage got a fully-rendered
 *          form. Post-fix (this commit) the backend gates the GET on a
 *          shape-check + ApiKey.findUnique lookup; malformed and unknown
 *          keys both 404. Slug-mode (no key) keeps working — no regression
 *          for partner sites that embed via tenant slug.
 *
 *   #378 — /api/wellness/public/tenant/:slug rejects slugs with spaces,
 *          uppercase, and special characters. Pre-fix the landing-pages slug
 *          field accepted free text and produced URLs like /book/My%20Page!.
 *          Pin: slug containing space / uppercase / `!` returns 404 (clinic
 *          not found) — the slug column is `lower-kebab-case` only by
 *          convention, so anything outside that set is unreachable.
 *
 * Why this spec exists alongside wellness.spec.js:
 *   • wellness.spec.js covers the END-TO-END public-booking happy path (book
 *     a visit, verify it shows up on the calendar). This spec covers the
 *     DEFENSIVE surface: every documented input validation, the rate-limit
 *     wire-up, and the embed-form GET gate that never had a per-push pin.
 *   • Adds explicit revert-and-prove evidence in the commit body — same
 *     discipline as wellness-rbac-regression-api.spec.js (commit 83d2a88)
 *     and auth-security-regression-api.spec.js (commit db543af).
 *
 * RUN_TAG: `E2E_PB_<ts>` — registered in e2e/test-data-patterns.js so
 * global-teardown sweeps any Patient / Visit rows created here. We also
 * try to disable created Visit rows directly in afterAll via the wellness
 * admin token (status=cancelled) so the calendar stays clean even on flaky
 * runs where global-teardown didn't fire.
 *
 * stripDangerous reminder: the global middleware deletes
 * `id, createdAt, updatedAt, tenantId, userId, isAdmin, passwordHash,
 * portalPasswordHash` from every request body. None of those are referenced
 * here — booking POSTs are name/phone/serviceId/locationId-shaped only.
 *
 * Test environment expectations:
 *   - BASE_URL pointing at a backend with the wellness routes mounted +
 *     the embed-gate route registered (server.js:535+). Per-push gate uses
 *     http://127.0.0.1:5000 (CI), local stack same. e2e-full uses
 *     https://crm.globusdemos.com — the embed gate test is conditionally
 *     skipped on cross-machine runs because Nginx serves /embed/* directly
 *     in production, bypassing the backend route entirely (the gate is
 *     intentionally local-stack-only; same shape as backup-engine-api.spec.js).
 *   - Wellness-admin login (`admin@wellness.demo`) for the post-201 visit
 *     readback (#279 pin) and the service-cap mutation tests (#218 pin).
 *
 * Revert-and-prove (P1 acceptance from regression-coverage-backlog.md):
 *   1. Remove `publicBookLimiter` middleware from POST /public/book
 *      → "RateLimit-Policy header emitted on /public/book" goes RED (#219.d pin)
 *   2. Comment out the embed-gate route in server.js
 *      → "/embed/lead-form.html?key=glbs_garbage returns 404" goes RED (#297 pin)
 *   3. Loosen the phone validation regex on /public/book to accept <10 digits
 *      → "phone='5' returns 400 INVALID_PHONE" goes RED (#219.a pin)
 *   4. Restore each → all tests GREEN.
 */
const { test, expect } = require('@playwright/test');

// Some tests in this file create Patient/Visit rows via the public endpoint
// and read them back through the wellness-admin token. Pin to serial to
// avoid a Visit-create + read-back race where another worker's afterAll
// scrubs the row before the read.
test.describe.configure({ mode: 'serial' });

const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:5000';
const API = `${BASE_URL}/api`;
const REQUEST_TIMEOUT = 30000;
const RUN_TAG = `E2E_PB_${Date.now()}`;

// Embed-gate route is registered ONLY on the local Express stack — Nginx
// serves /embed/* directly in production. Same guard pattern as
// backup-engine-api.spec.js. Without this guard the embed test would
// cascade-fail in e2e-full (BASE_URL=https://crm.globusdemos.com).
const IS_LOCAL_STACK = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/.test(BASE_URL);

const FIXTURES = {
  wellnessAdmin: { email: 'admin@wellness.demo', password: 'password123' },
  // Generic-tenant USER (not admin) — used for the customer-portal contract
  // pin (#208). The customer portal is contact-scoped, not user-scoped, so
  // we authenticate against /api/portal/login with a known portal-enabled
  // contact email instead. See setupPortalContact below.
};

const tokens = {};

async function login(request, fixture) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await request.post(`${API}/auth/login`, {
        data: fixture,
        headers: { 'Content-Type': 'application/json' },
        timeout: REQUEST_TIMEOUT,
      });
      if (r.ok()) return r.json();
    } catch (_e) {
      if (attempt === 0) continue;
    }
  }
  return null;
}

const authHdr = (token) => ({
  Authorization: `Bearer ${token}`,
  'Content-Type': 'application/json',
});

// Choose a phone in the 9999900000-9999999999 range so it doesn't collide
// with seeded patient phones (which start 9811xxxxxxx and 98765xxxxx).
function randomTestPhone() {
  return `9999${String(Math.floor(100000 + Math.random() * 899999))}`;
}

// Visits we create via the public route get their visitId pushed here so
// afterAll can mark them cancelled (no DELETE endpoint on /visits — same
// shape as wellness-rbac-regression cleanup).
const createdVisitIds = [];
const createdPatientPhones = [];

let wellnessServiceId = null;
let wellnessLocationId = null;

test.beforeAll(async ({ request }) => {
  const data = await login(request, FIXTURES.wellnessAdmin);
  if (data) tokens.wellnessAdmin = data.token;

  // Pull a real service + location off the public catalog so the booking
  // POSTs reference something the tenant actually has. Public endpoint
  // already filters internal/dev names per #291.
  const profile = await request.get(`${API}/wellness/public/tenant/enhanced-wellness`, {
    timeout: REQUEST_TIMEOUT,
  });
  if (profile.ok()) {
    const body = await profile.json();
    const services = Array.isArray(body.services) ? body.services : [];
    const locations = Array.isArray(body.locations) ? body.locations : [];
    // Pick a normally-priced service (not the smoke-test "Z" row if it ever
    // re-appeared); first one with basePrice>0 is fine.
    const realSvc = services.find((s) => s.basePrice > 0) || services[0];
    wellnessServiceId = realSvc?.id ?? null;
    wellnessLocationId = locations[0]?.id ?? null;
  }
});

test.afterAll(async ({ request }) => {
  if (!tokens.wellnessAdmin) return;
  // Mark created visits as cancelled so they don't pollute the calendar.
  for (const visitId of createdVisitIds) {
    try {
      await request.put(`${API}/wellness/visits/${visitId}`, {
        headers: authHdr(tokens.wellnessAdmin),
        data: { status: 'cancelled', notes: `_teardown_${RUN_TAG}` },
        timeout: REQUEST_TIMEOUT,
      });
    } catch (_e) {
      // Best-effort; global-teardown sweeps by RUN_TAG name match anyway.
    }
  }
  // Wave 2 Agent LL — restore the test service's supportedBookingTypes to
  // the legacy default (null = back-compat CLINIC_VISIT-only) so the next
  // test run starts from a clean catalog state. Best-effort; if this fails
  // the tests still re-set the column at the start of every test that
  // depends on it via setSupportedTypes.
  if (wellnessServiceId) {
    try {
      await request.put(`${API}/wellness/services/${wellnessServiceId}`, {
        headers: authHdr(tokens.wellnessAdmin),
        data: { supportedBookingTypes: null },
        timeout: REQUEST_TIMEOUT,
      });
    } catch (_e) {
      // Best-effort.
    }
  }
});

// ──────────────────────────────────────────────────────────────────────
// #219 — POST /public/book validation gates
// ──────────────────────────────────────────────────────────────────────

test.describe('#219 — public booking validation gates', () => {
  test('phone with letters → 400 INVALID_PHONE', async ({ request }) => {
    test.skip(!wellnessServiceId, 'wellness service not seeded');
    const r = await request.post(`${API}/wellness/public/book`, {
      data: {
        tenantSlug: 'enhanced-wellness',
        serviceId: wellnessServiceId,
        locationId: wellnessLocationId,
        name: `${RUN_TAG} Letters Phone`,
        phone: 'abcdefghij',
      },
      headers: { 'Content-Type': 'application/json' },
      timeout: REQUEST_TIMEOUT,
    });
    expect(r.status()).toBe(400);
    const body = await r.json();
    expect(body.code).toBe('INVALID_PHONE');
  });

  test('phone < 10 digits → 400 INVALID_PHONE', async ({ request }) => {
    test.skip(!wellnessServiceId, 'wellness service not seeded');
    const r = await request.post(`${API}/wellness/public/book`, {
      data: {
        tenantSlug: 'enhanced-wellness',
        serviceId: wellnessServiceId,
        locationId: wellnessLocationId,
        name: `${RUN_TAG} Short Phone`,
        phone: '5',
      },
      headers: { 'Content-Type': 'application/json' },
      timeout: REQUEST_TIMEOUT,
    });
    expect(r.status()).toBe(400);
    const body = await r.json();
    expect(body.code).toBe('INVALID_PHONE');
  });

  test('phone with foreign-format prefix not 6/7/8/9 → 400 INVALID_PHONE', async ({ request }) => {
    test.skip(!wellnessServiceId, 'wellness service not seeded');
    // "+15551234567" — valid US E.164 length, but not an Indian mobile.
    // The route's regex requires the trailing 10 to start 6/7/8/9.
    const r = await request.post(`${API}/wellness/public/book`, {
      data: {
        tenantSlug: 'enhanced-wellness',
        serviceId: wellnessServiceId,
        locationId: wellnessLocationId,
        name: `${RUN_TAG} US Phone`,
        phone: '+15551234567',
      },
      headers: { 'Content-Type': 'application/json' },
      timeout: REQUEST_TIMEOUT,
    });
    expect(r.status()).toBe(400);
    const body = await r.json();
    expect(body.code).toBe('INVALID_PHONE');
  });

  test('preferredSlot in the past (1900-01-01) → 400 SLOT_IN_PAST', async ({ request }) => {
    test.skip(!wellnessServiceId, 'wellness service not seeded');
    const r = await request.post(`${API}/wellness/public/book`, {
      data: {
        tenantSlug: 'enhanced-wellness',
        serviceId: wellnessServiceId,
        locationId: wellnessLocationId,
        name: `${RUN_TAG} Old Date`,
        phone: randomTestPhone(),
        preferredSlot: '1900-01-01T10:30:00.000Z',
      },
      headers: { 'Content-Type': 'application/json' },
      timeout: REQUEST_TIMEOUT,
    });
    expect(r.status()).toBe(400);
    const body = await r.json();
    expect(body.code).toBe('SLOT_IN_PAST');
  });

  test('preferredSlot > 90 days out → 400 SLOT_TOO_FAR (also covers >365d)', async ({ request }) => {
    test.skip(!wellnessServiceId, 'wellness service not seeded');
    // 400 days out — well past both the 90-day route cap AND the
    // acceptance's 365-day boundary. If the cap is removed entirely this
    // test goes red.
    const farFuture = new Date(Date.now() + 400 * 24 * 3600 * 1000).toISOString();
    const r = await request.post(`${API}/wellness/public/book`, {
      data: {
        tenantSlug: 'enhanced-wellness',
        serviceId: wellnessServiceId,
        locationId: wellnessLocationId,
        name: `${RUN_TAG} Far Future`,
        phone: randomTestPhone(),
        preferredSlot: farFuture,
      },
      headers: { 'Content-Type': 'application/json' },
      timeout: REQUEST_TIMEOUT,
    });
    expect(r.status()).toBe(400);
    const body = await r.json();
    expect(body.code).toBe('SLOT_TOO_FAR');
  });

  test('emits draft-7 RateLimit headers (10/min/IP policy wired)', async ({ request }) => {
    test.skip(!wellnessServiceId, 'wellness service not seeded');
    // Hit with intentionally-bad data so the 400 path returns fast — we
    // only care about the headers, not the body. The limiter middleware
    // runs BEFORE the route handler so 400/201 both surface the headers.
    const r = await request.post(`${API}/wellness/public/book`, {
      data: {
        tenantSlug: 'enhanced-wellness',
        serviceId: wellnessServiceId,
        locationId: wellnessLocationId,
        name: 'Headers Probe',
        phone: 'abc',
      },
      headers: { 'Content-Type': 'application/json' },
      timeout: REQUEST_TIMEOUT,
    });
    const headers = r.headers();
    // Either of the draft-7 headers proves the limiter is wired. The
    // `RateLimit-Policy` is the most specific (carries `;w=60` for the
    // 1-minute window) — assert that one explicitly to catch a regression
    // that swaps publicBookLimiter for one with the wrong window.
    const policy = headers['ratelimit-policy'] || headers['ratelimit'];
    expect(
      policy,
      'publicBookLimiter is unwired — no draft-7 RateLimit headers on /public/book'
    ).toBeTruthy();
    // The policy should reference a 60-second window (`w=60` in draft-7
    // semicolon syntax, or `reset=60` in the combined-format header).
    // If someone swaps the limiter to a 15-min window, this regresses.
    expect(
      String(policy),
      `expected 60-second window on publicBookLimiter, got: ${policy}`
    ).toMatch(/(?:w=60\b|reset=60\b)/);
  });
});

// ──────────────────────────────────────────────────────────────────────
// #279 — 201 only when both Patient AND Visit rows persisted
// ──────────────────────────────────────────────────────────────────────

test.describe('#279 — public booking persists Patient + Visit atomically', () => {
  test('successful POST creates a visit reachable via /wellness/visits', async ({ request }) => {
    test.skip(!wellnessServiceId, 'wellness service not seeded');
    test.skip(!tokens.wellnessAdmin, 'wellness admin login unavailable');

    const phone = randomTestPhone();
    createdPatientPhones.push(phone);
    // Use a slot 7 days out to stay inside the 90-day window.
    const slot = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();
    const r = await request.post(`${API}/wellness/public/book`, {
      data: {
        tenantSlug: 'enhanced-wellness',
        serviceId: wellnessServiceId,
        locationId: wellnessLocationId,
        name: `${RUN_TAG} Atomic Patient`,
        phone,
        preferredSlot: slot,
        notes: `${RUN_TAG} created`,
      },
      headers: { 'Content-Type': 'application/json' },
      timeout: REQUEST_TIMEOUT,
    });
    expect(r.status(), `body: ${(await r.text()).slice(0, 200)}`).toBe(201);
    const body = await r.json();
    expect(body.ok).toBe(true);
    expect(body.visit).toBeTruthy();
    expect(body.visit.id).toEqual(expect.any(Number));
    expect(body.patient).toBeTruthy();
    expect(body.patient.id).toEqual(expect.any(Number));
    createdVisitIds.push(body.visit.id);

    // Verify the visit is reachable from the wellness-admin's view —
    // i.e. it actually persisted past the response, didn't roll back
    // post-201 (the original #279 silent-data-loss bug).
    const lookup = await request.get(
      `${API}/wellness/visits?phone=${encodeURIComponent(phone)}`,
      { headers: authHdr(tokens.wellnessAdmin), timeout: REQUEST_TIMEOUT }
    );
    expect(lookup.status()).toBe(200);
    const lookupBody = await lookup.json();
    const visits = Array.isArray(lookupBody) ? lookupBody : (lookupBody.visits || lookupBody.data || []);
    const found = visits.find((v) => v.id === body.visit.id);
    expect(
      found,
      `visit ${body.visit.id} (the just-booked one) is not reachable on /wellness/visits — silent data loss regression`
    ).toBeTruthy();
  });

  test('invalid serviceId → 400 INVALID_SERVICE, no Patient row created', async ({ request }) => {
    test.skip(!tokens.wellnessAdmin, 'wellness admin login unavailable');
    const phone = randomTestPhone();
    const r = await request.post(`${API}/wellness/public/book`, {
      data: {
        tenantSlug: 'enhanced-wellness',
        serviceId: 99999999, // Doesn't exist on this tenant
        locationId: wellnessLocationId,
        name: `${RUN_TAG} No Service`,
        phone,
      },
      headers: { 'Content-Type': 'application/json' },
      timeout: REQUEST_TIMEOUT,
    });
    expect(r.status()).toBe(400);
    const body = await r.json();
    expect(body.code).toBe('INVALID_SERVICE');

    // Verify no orphan Patient row was created (#279's worst-case path).
    // The /wellness/patients route's search param is `q` and matches against
    // name/phone/email via `contains`. Use the unique phone we just sent so
    // any returned row is direct evidence of an orphan.
    const lookup = await request.get(
      `${API}/wellness/patients?q=${encodeURIComponent(phone)}`,
      { headers: authHdr(tokens.wellnessAdmin), timeout: REQUEST_TIMEOUT }
    );
    if (lookup.ok()) {
      const lookupBody = await lookup.json();
      const patients = Array.isArray(lookupBody) ? lookupBody : (lookupBody.patients || lookupBody.data || []);
      // Filter STRICTLY to rows whose phone contains the random phone we
      // sent — defensive in case the route returns extra context. The phone
      // is randomized 9999XXXXXX so a contains() match is effectively unique
      // to this test's POST.
      const orphans = patients.filter((p) => String(p.phone || '').includes(phone));
      expect(
        orphans.length,
        `orphan Patient row created on validation failure — #279 silent-data-loss regression. orphans: ${JSON.stringify(orphans.map((p) => ({ id: p.id, phone: p.phone })))}`
      ).toBe(0);
    }
  });
});

// ──────────────────────────────────────────────────────────────────────
// #218 — service catalog price/duration caps (regression on #209's caps)
// ──────────────────────────────────────────────────────────────────────

test.describe('#218 — service catalog rejects garbage price/duration', () => {
  test('basePrice > 1e8 → 400 PRICE_TOO_HIGH', async ({ request }) => {
    test.skip(!tokens.wellnessAdmin, 'wellness admin login unavailable');
    const r = await request.post(`${API}/wellness/services`, {
      headers: authHdr(tokens.wellnessAdmin),
      data: {
        name: `${RUN_TAG} Overflow Service`,
        category: 'test',
        basePrice: 1e8, // ₹10 crore — well past the 50L cap
        durationMin: 30,
      },
      timeout: REQUEST_TIMEOUT,
    });
    expect(r.status()).toBe(400);
    const body = await r.json();
    expect(body.code).toBe('PRICE_TOO_HIGH');
  });

  test('durationMin > 1440 → 400 DURATION_TOO_HIGH', async ({ request }) => {
    test.skip(!tokens.wellnessAdmin, 'wellness admin login unavailable');
    const r = await request.post(`${API}/wellness/services`, {
      headers: authHdr(tokens.wellnessAdmin),
      data: {
        name: `${RUN_TAG} Long Service`,
        category: 'test',
        basePrice: 1000,
        durationMin: 1441, // 1 minute past 24h — well past the 720-min cap
      },
      timeout: REQUEST_TIMEOUT,
    });
    expect(r.status()).toBe(400);
    const body = await r.json();
    expect(body.code).toBe('DURATION_TOO_HIGH');
  });

  test('PUT to update existing service applies the same caps', async ({ request }) => {
    test.skip(!tokens.wellnessAdmin, 'wellness admin login unavailable');
    test.skip(!wellnessServiceId, 'wellness service not seeded');
    // Try to bump an existing service's price past the cap. This pin
    // catches a regression where someone forgets to apply the create-time
    // cap to the update-time path (real bug shape from #115/#209 history).
    const r = await request.put(`${API}/wellness/services/${wellnessServiceId}`, {
      headers: authHdr(tokens.wellnessAdmin),
      data: { basePrice: 1e9 }, // ₹100 crore
      timeout: REQUEST_TIMEOUT,
    });
    expect(r.status()).toBe(400);
    const body = await r.json();
    expect(body.code).toBe('PRICE_TOO_HIGH');
  });
});

// ──────────────────────────────────────────────────────────────────────
// #378 — public tenant lookup rejects malformed slugs
// ──────────────────────────────────────────────────────────────────────

test.describe('#378 — /public/tenant/:slug rejects malformed slugs', () => {
  // Each of these is shape-incompatible with the lower-kebab-case slug
  // convention. The route uses findUnique(slug), so any of these returns
  // 404 by virtue of "no row matches" — but a future refactor that
  // accepted them by case-insensitive match or strip-special would
  // create real-tenant collisions. Pin the rejection here.
  const malformed = [
    { name: 'spaces',    slug: 'enhanced wellness' },
    { name: 'uppercase', slug: 'ENHANCED-WELLNESS' },
    { name: 'specials',  slug: 'enhanced!wellness' },
    { name: 'dot-path',  slug: 'enhanced.wellness' },
  ];

  for (const { name, slug } of malformed) {
    test(`slug with ${name} → 404 (no clinic match)`, async ({ request }) => {
      const r = await request.get(
        `${API}/wellness/public/tenant/${encodeURIComponent(slug)}`,
        { timeout: REQUEST_TIMEOUT }
      );
      expect(r.status(), `slug "${slug}" should not match the canonical tenant`).toBe(404);
    });
  }

  test('canonical slug "enhanced-wellness" → 200 (positive control)', async ({ request }) => {
    // Without this control, the rejection tests are trivially-true if the
    // whole route is broken. Pin the happy path here.
    const r = await request.get(
      `${API}/wellness/public/tenant/enhanced-wellness`,
      { timeout: REQUEST_TIMEOUT }
    );
    expect(r.status()).toBe(200);
    const body = await r.json();
    expect(body.tenant?.slug).toBe('enhanced-wellness');
    expect(body.tenant?.vertical).toBe('wellness');
  });
});

// ──────────────────────────────────────────────────────────────────────
// #291 — internal/dev location names are filtered from public catalog
// ──────────────────────────────────────────────────────────────────────

test.describe('#291 — public tenant view filters internal location names', () => {
  test('no location with smoke-test / e2e- / test- / qa- / dev- prefix is exposed', async ({ request }) => {
    const r = await request.get(
      `${API}/wellness/public/tenant/enhanced-wellness`,
      { timeout: REQUEST_TIMEOUT }
    );
    expect(r.status()).toBe(200);
    const body = await r.json();
    const locations = Array.isArray(body.locations) ? body.locations : [];
    const INTERNAL_RE = /^(smoke-test|e2e[-_ ]|test[-_ ]|qa[-_ ]|dev[-_ ])/i;
    const leaked = locations.filter((l) => INTERNAL_RE.test(String(l.name || '').trim()));
    expect(
      leaked.map((l) => l.name),
      `internal/dev location names leaked into public response: ${JSON.stringify(leaked.map((l) => l.name))}`
    ).toEqual([]);
  });
});

// ──────────────────────────────────────────────────────────────────────
// #297 — /embed/lead-form.html GET-time API key gate
// ──────────────────────────────────────────────────────────────────────

test.describe('#297 — embed widget GETs are gated on API key validity', () => {
  test('GET /embed/lead-form.html with no key → 200 (slug-mode keeps working)', async ({ request }) => {
    test.skip(!IS_LOCAL_STACK, '/embed/* served by Nginx in production — backend gate is local-stack-only');
    const r = await request.get(`${BASE_URL}/embed/lead-form.html`, {
      timeout: REQUEST_TIMEOUT,
    });
    expect(r.status()).toBe(200);
    const html = await r.text();
    // Sanity: it actually IS the form, not some other 200.
    expect(html).toContain('Powered by');
  });

  test('GET /embed/lead-form.html?key=<malformed> → 404', async ({ request }) => {
    test.skip(!IS_LOCAL_STACK, '/embed/* served by Nginx in production — backend gate is local-stack-only');
    const r = await request.get(
      `${BASE_URL}/embed/lead-form.html?key=garbage_no_glbs_prefix`,
      { timeout: REQUEST_TIMEOUT }
    );
    expect(r.status()).toBe(404);
  });

  test('GET /embed/lead-form.html?key=glbs_<unknown> → 404', async ({ request }) => {
    test.skip(!IS_LOCAL_STACK, '/embed/* served by Nginx in production — backend gate is local-stack-only');
    // Shape-valid prefix but no row in ApiKey table for this value.
    const r = await request.get(
      `${BASE_URL}/embed/lead-form.html?key=glbs_${'a'.repeat(20)}`,
      { timeout: REQUEST_TIMEOUT }
    );
    expect(r.status()).toBe(404);
  });
});

// ──────────────────────────────────────────────────────────────────────
// #208 — /api/portal serves the customer portal contract, NOT KB
// ──────────────────────────────────────────────────────────────────────

test.describe('#208 — /api/portal/me is the customer-portal endpoint', () => {
  test('GET /api/portal/me without token → 401 (auth-required, not anonymous KB read)', async ({ request }) => {
    // The customer portal contract requires its own portal token (from
    // /api/portal/login), NOT a staff JWT. A regression that flips this
    // route to the KB module's auth model (or no-auth — pre-#208 the
    // /portal SPA route rendered an unauthenticated KB page) goes red
    // here. Both the global JWT guard ("Authentication required") and the
    // route's verifyPortalToken ("Portal token required") map to 401 with
    // an `error` field — pin the rejection, not the specific message.
    const r = await request.get(`${API}/portal/me`, { timeout: REQUEST_TIMEOUT });
    expect(r.status()).toBe(401);
    const body = await r.json();
    expect(body).toHaveProperty('error');
    // The KB module has its own /api/knowledge-base/public/* surface that
    // 200s without any auth. Pin the contrast: /api/portal/me is contact-
    // scoped (auth required) and /api/knowledge-base/public/<slug>/categories
    // is anonymous. If those two converge again, we lose #208's namespace
    // separation.
    const kbProbe = await request.get(
      `${API}/knowledge-base/public/enhanced-wellness/categories`,
      { timeout: REQUEST_TIMEOUT }
    );
    // KB public endpoint is anonymous-readable (200 or 404 if no KB seeded);
    // CRITICAL: it must NOT return 401 — that would mean the routes have
    // collapsed onto a shared auth gate.
    expect(kbProbe.status()).not.toBe(401);
  });

  test('GET /api/portal/me with a wellness PATIENT token → 401 (different token type)', async ({ request }) => {
    // Forge a wellness patient-portal token shape (`{patientId}` claim) and
    // confirm the customer-portal route refuses it. Pre-#208 the two route
    // families could have shared validation; the fix made each one verify
    // its own token shape independently. Here we use an obviously-fake
    // token to test the rejection path — since the route checks
    // `decoded.type !== "PORTAL"`, a non-PORTAL JWT (or any unsigned
    // garbage) is rejected. The wellness portal mints `{patientId}` tokens
    // with no `type` field, so even a real wellness-portal token would
    // 401 here. We use a fake token to keep the test free of patient
    // OTP/SMS dependencies.
    const fakeToken = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJwYXRpZW50SWQiOjF9.fake_signature';
    const r = await request.get(`${API}/portal/me`, {
      headers: { Authorization: `Bearer ${fakeToken}` },
      timeout: REQUEST_TIMEOUT,
    });
    expect(r.status()).toBe(401);
  });

  test('GET /api/wellness/portal/health is reachable without auth (different namespace)', async ({ request }) => {
    // Companion check: the wellness patient-portal namespace at
    // /api/wellness/portal/* is its own surface; this confirms the two
    // portals are truly separate routes with different contracts. KB has
    // no /portal/health probe — finding one here means the router-mount
    // is correct (#208's namespacing fix).
    const r = await request.get(`${API}/wellness/portal/health`, {
      timeout: REQUEST_TIMEOUT,
    });
    expect(r.status()).toBe(200);
    const body = await r.json();
    expect(body).toHaveProperty('smsConfigured');
  });
});

// ──────────────────────────────────────────────────────────────────────
// Wave 2 Agent LL — bookingType + at-home address + UTM capture
// ──────────────────────────────────────────────────────────────────────
//
// Closes the booking-widget completion gap from the 2026-05-08 Google Doc
// audit (TODOS.md:19 — "bookingType enum + At-Home address+travel-time +
// UTM-into-booking missing"). Pins the new contract on the public booking
// route so any future refactor that drops a field, swaps a status code, or
// regresses validation goes RED at gate.
//
// Contract pinned by these tests:
//   • POST /public/book accepts an optional bookingType in
//     {CLINIC_VISIT, IN_HOME, VIDEO, PHONE}; default is CLINIC_VISIT.
//   • IN_HOME requires atHomeAddress (5–500 chars) + atHomePincode (6 digits).
//   • IN_HOME response carries travelTimeMinutes (default 30).
//   • VIDEO response carries an auto-generated videoCallUrl.
//   • Service.supportedBookingTypes (JSON-string column) gates the chosen
//     bookingType — mismatch returns 422 BOOKING_TYPE_NOT_SUPPORTED.
//   • UTM payload (utm_*, referrer) persists on the Visit row and is
//     readable via the wellness-admin's /wellness/visits view.
//   • Backwards-compat: payloads without bookingType still 201 (no
//     "bookingType required" regression).
//
// New service rows created here for the supported-list test are torn down
// in afterAll via DELETE /wellness/services/:id (the wellness route exposes
// soft-delete via `isActive=false` — see existing #218 spec) so they don't
// pollute the catalog across runs.
test.describe('Wave 2 Agent LL — bookingType + at-home + UTM capture', () => {
  // Helper: discover a service id that supports IN_HOME on the catalog.
  // Pre-seed services don't have supportedBookingTypes set (legacy default
  // is CLINIC_VISIT-only), so each test mutates a service via PUT then
  // restores it. Mutation is scoped by the wellness-admin token.
  async function setSupportedTypes(request, serviceId, types) {
    return request.put(`${API}/wellness/services/${serviceId}`, {
      headers: authHdr(tokens.wellnessAdmin),
      data: { supportedBookingTypes: types },
      timeout: REQUEST_TIMEOUT,
    });
  }

  test('GET /public/tenant/:slug exposes supportedBookingTypes per service (back-compat default)', async ({ request }) => {
    // Legacy services with null column should expose ["CLINIC_VISIT"] —
    // the widget never sees an empty list, so it always has SOMETHING to
    // render in the booking-type picker.
    const r = await request.get(`${API}/wellness/public/tenant/enhanced-wellness`, {
      timeout: REQUEST_TIMEOUT,
    });
    expect(r.status()).toBe(200);
    const body = await r.json();
    const services = Array.isArray(body.services) ? body.services : [];
    expect(services.length).toBeGreaterThan(0);
    for (const s of services) {
      expect(
        Array.isArray(s.supportedBookingTypes),
        `service ${s.id} (${s.name}) — supportedBookingTypes must be an array on the public response`
      ).toBe(true);
      expect(s.supportedBookingTypes.length).toBeGreaterThan(0);
      // Every value must be one of the enum members.
      for (const t of s.supportedBookingTypes) {
        expect(['CLINIC_VISIT', 'IN_HOME', 'VIDEO', 'PHONE']).toContain(t);
      }
    }
  });

  test('backwards-compat: POST /public/book without bookingType defaults to CLINIC_VISIT', async ({ request }) => {
    test.skip(!wellnessServiceId, 'wellness service not seeded');
    test.skip(!tokens.wellnessAdmin, 'wellness admin login unavailable');
    // Ensure the test service supports CLINIC_VISIT (the default).
    await setSupportedTypes(request, wellnessServiceId, ['CLINIC_VISIT']);
    const phone = randomTestPhone();
    createdPatientPhones.push(phone);
    const r = await request.post(`${API}/wellness/public/book`, {
      data: {
        tenantSlug: 'enhanced-wellness',
        serviceId: wellnessServiceId,
        locationId: wellnessLocationId,
        name: `${RUN_TAG} BackCompat`,
        phone,
      },
      headers: { 'Content-Type': 'application/json' },
      timeout: REQUEST_TIMEOUT,
    });
    expect(r.status(), `body: ${(await r.text()).slice(0, 200)}`).toBe(201);
    const body = await r.json();
    expect(body.visit.bookingType).toBe('CLINIC_VISIT');
    // No at-home / video fields populated for the legacy path.
    expect(body.visit.atHomeAddress).toBeNull();
    expect(body.visit.travelTimeMinutes).toBeNull();
    expect(body.visit.videoCallUrl).toBeNull();
    createdVisitIds.push(body.visit.id);
  });

  test('IN_HOME with valid address + pincode → 201 with travelTimeMinutes default', async ({ request }) => {
    test.skip(!wellnessServiceId, 'wellness service not seeded');
    test.skip(!tokens.wellnessAdmin, 'wellness admin login unavailable');
    // Allow IN_HOME on the test service.
    const setup = await setSupportedTypes(request, wellnessServiceId, ['CLINIC_VISIT', 'IN_HOME']);
    expect(setup.status()).toBe(200);
    const phone = randomTestPhone();
    createdPatientPhones.push(phone);
    const r = await request.post(`${API}/wellness/public/book`, {
      data: {
        tenantSlug: 'enhanced-wellness',
        serviceId: wellnessServiceId,
        locationId: wellnessLocationId,
        name: `${RUN_TAG} AtHome`,
        phone,
        bookingType: 'IN_HOME',
        atHomeAddress: 'Flat 4B, Springwood Apartments, Sector 51',
        atHomeCity: 'Gurgaon',
        atHomePincode: '122001',
      },
      headers: { 'Content-Type': 'application/json' },
      timeout: REQUEST_TIMEOUT,
    });
    expect(r.status(), `body: ${(await r.text()).slice(0, 300)}`).toBe(201);
    const body = await r.json();
    expect(body.visit.bookingType).toBe('IN_HOME');
    expect(body.visit.atHomeAddress).toContain('Springwood');
    expect(body.visit.atHomeCity).toBe('Gurgaon');
    expect(body.visit.atHomePincode).toBe('122001');
    // Wave 8b: travelTimeMinutes is now zone-based (lib/pincodeZones.js).
    // Clinic seed pincode is 834008 (Ranchi, non-metro) and patient is
    // 122001 (Gurgaon, non-metro) — both unknown to METRO_PREFIXES so the
    // helper returns OUTSIDE_METRO_MINUTES (90). The original "MVP default
    // 30" only applied to the flat-default code path that pincodeZones
    // replaced. Assert on the contract: a positive integer in the legal
    // band (30 / 60 / 90), not the literal 30.
    expect(typeof body.visit.travelTimeMinutes).toBe('number');
    expect([30, 60, 90]).toContain(body.visit.travelTimeMinutes);
    expect(body.visit.videoCallUrl).toBeNull();
    createdVisitIds.push(body.visit.id);
  });

  test('IN_HOME without atHomeAddress → 400 INVALID_INPUT', async ({ request }) => {
    test.skip(!wellnessServiceId, 'wellness service not seeded');
    test.skip(!tokens.wellnessAdmin, 'wellness admin login unavailable');
    await setSupportedTypes(request, wellnessServiceId, ['CLINIC_VISIT', 'IN_HOME']);
    const r = await request.post(`${API}/wellness/public/book`, {
      data: {
        tenantSlug: 'enhanced-wellness',
        serviceId: wellnessServiceId,
        locationId: wellnessLocationId,
        name: `${RUN_TAG} NoAddr`,
        phone: randomTestPhone(),
        bookingType: 'IN_HOME',
        atHomePincode: '122001',
        // atHomeAddress missing
      },
      headers: { 'Content-Type': 'application/json' },
      timeout: REQUEST_TIMEOUT,
    });
    expect(r.status()).toBe(400);
    const body = await r.json();
    expect(body.code).toBe('INVALID_INPUT');
    expect(String(body.error)).toMatch(/atHomeAddress/i);
  });

  test('IN_HOME with malformed pincode → 400 INVALID_INPUT', async ({ request }) => {
    test.skip(!wellnessServiceId, 'wellness service not seeded');
    test.skip(!tokens.wellnessAdmin, 'wellness admin login unavailable');
    await setSupportedTypes(request, wellnessServiceId, ['CLINIC_VISIT', 'IN_HOME']);
    const r = await request.post(`${API}/wellness/public/book`, {
      data: {
        tenantSlug: 'enhanced-wellness',
        serviceId: wellnessServiceId,
        locationId: wellnessLocationId,
        name: `${RUN_TAG} BadPin`,
        phone: randomTestPhone(),
        bookingType: 'IN_HOME',
        atHomeAddress: 'Some real address that is long enough to pass length check',
        atHomePincode: 'ABC123', // not 6 digits
      },
      headers: { 'Content-Type': 'application/json' },
      timeout: REQUEST_TIMEOUT,
    });
    expect(r.status()).toBe(400);
    const body = await r.json();
    expect(body.code).toBe('INVALID_INPUT');
    expect(String(body.error)).toMatch(/pincode/i);
  });

  test('VIDEO booking → 201 with auto-generated videoCallUrl', async ({ request }) => {
    test.skip(!wellnessServiceId, 'wellness service not seeded');
    test.skip(!tokens.wellnessAdmin, 'wellness admin login unavailable');
    await setSupportedTypes(request, wellnessServiceId, ['CLINIC_VISIT', 'VIDEO']);
    const phone = randomTestPhone();
    createdPatientPhones.push(phone);
    const r = await request.post(`${API}/wellness/public/book`, {
      data: {
        tenantSlug: 'enhanced-wellness',
        serviceId: wellnessServiceId,
        locationId: wellnessLocationId,
        name: `${RUN_TAG} Video`,
        phone,
        bookingType: 'VIDEO',
      },
      headers: { 'Content-Type': 'application/json' },
      timeout: REQUEST_TIMEOUT,
    });
    expect(r.status(), `body: ${(await r.text()).slice(0, 200)}`).toBe(201);
    const body = await r.json();
    expect(body.visit.bookingType).toBe('VIDEO');
    expect(body.visit.videoCallUrl).toBeTruthy();
    expect(String(body.visit.videoCallUrl)).toMatch(/^https?:\/\//);
    // No at-home fields on a VIDEO booking.
    expect(body.visit.atHomeAddress).toBeNull();
    expect(body.visit.travelTimeMinutes).toBeNull();
    createdVisitIds.push(body.visit.id);
  });

  test('PHONE booking → 201 (voice-only, no at-home / video link)', async ({ request }) => {
    test.skip(!wellnessServiceId, 'wellness service not seeded');
    test.skip(!tokens.wellnessAdmin, 'wellness admin login unavailable');
    await setSupportedTypes(request, wellnessServiceId, ['CLINIC_VISIT', 'PHONE']);
    const phone = randomTestPhone();
    createdPatientPhones.push(phone);
    const r = await request.post(`${API}/wellness/public/book`, {
      data: {
        tenantSlug: 'enhanced-wellness',
        serviceId: wellnessServiceId,
        locationId: wellnessLocationId,
        name: `${RUN_TAG} Phone`,
        phone,
        bookingType: 'PHONE',
      },
      headers: { 'Content-Type': 'application/json' },
      timeout: REQUEST_TIMEOUT,
    });
    expect(r.status()).toBe(201);
    const body = await r.json();
    expect(body.visit.bookingType).toBe('PHONE');
    expect(body.visit.atHomeAddress).toBeNull();
    expect(body.visit.travelTimeMinutes).toBeNull();
    expect(body.visit.videoCallUrl).toBeNull();
    createdVisitIds.push(body.visit.id);
  });

  test('unknown bookingType (e.g. TELEPATHY) → 400 INVALID_INPUT', async ({ request }) => {
    test.skip(!wellnessServiceId, 'wellness service not seeded');
    const r = await request.post(`${API}/wellness/public/book`, {
      data: {
        tenantSlug: 'enhanced-wellness',
        serviceId: wellnessServiceId,
        locationId: wellnessLocationId,
        name: `${RUN_TAG} Bogus`,
        phone: randomTestPhone(),
        bookingType: 'TELEPATHY',
      },
      headers: { 'Content-Type': 'application/json' },
      timeout: REQUEST_TIMEOUT,
    });
    expect(r.status()).toBe(400);
    const body = await r.json();
    expect(body.code).toBe('INVALID_INPUT');
    expect(String(body.error)).toMatch(/bookingType/i);
  });

  test('IN_HOME on a CLINIC_VISIT-only service → 422 BOOKING_TYPE_NOT_SUPPORTED', async ({ request }) => {
    test.skip(!wellnessServiceId, 'wellness service not seeded');
    test.skip(!tokens.wellnessAdmin, 'wellness admin login unavailable');
    // Lock the service down to CLINIC_VISIT only.
    await setSupportedTypes(request, wellnessServiceId, ['CLINIC_VISIT']);
    const r = await request.post(`${API}/wellness/public/book`, {
      data: {
        tenantSlug: 'enhanced-wellness',
        serviceId: wellnessServiceId,
        locationId: wellnessLocationId,
        name: `${RUN_TAG} NoIH`,
        phone: randomTestPhone(),
        bookingType: 'IN_HOME',
        atHomeAddress: 'Some long enough address text',
        atHomePincode: '122001',
      },
      headers: { 'Content-Type': 'application/json' },
      timeout: REQUEST_TIMEOUT,
    });
    expect(r.status()).toBe(422);
    const body = await r.json();
    expect(body.code).toBe('BOOKING_TYPE_NOT_SUPPORTED');
    // The response also returns the actual supported list so the widget can
    // show an explanatory banner without re-fetching the catalog.
    expect(Array.isArray(body.supportedBookingTypes)).toBe(true);
    expect(body.supportedBookingTypes).toEqual(['CLINIC_VISIT']);
  });

  test('UTM payload + referrer persist on the Visit row', async ({ request }) => {
    test.skip(!wellnessServiceId, 'wellness service not seeded');
    test.skip(!tokens.wellnessAdmin, 'wellness admin login unavailable');
    await setSupportedTypes(request, wellnessServiceId, ['CLINIC_VISIT']);
    const phone = randomTestPhone();
    createdPatientPhones.push(phone);
    const utm = {
      utmSource: 'google',
      utmMedium: 'cpc',
      utmCampaign: 'summer-skin-2026',
      utmTerm: 'aesthetics gurgaon',
      utmContent: 'banner-top-a',
    };
    const referrer = 'https://www.google.com/search?q=enhanced+wellness';
    const r = await request.post(`${API}/wellness/public/book`, {
      data: {
        tenantSlug: 'enhanced-wellness',
        serviceId: wellnessServiceId,
        locationId: wellnessLocationId,
        name: `${RUN_TAG} UTM`,
        phone,
        utm,
        referrer,
      },
      headers: { 'Content-Type': 'application/json' },
      timeout: REQUEST_TIMEOUT,
    });
    expect(r.status(), `body: ${(await r.text()).slice(0, 300)}`).toBe(201);
    const body = await r.json();
    createdVisitIds.push(body.visit.id);

    // Read back via wellness-admin to confirm the UTM fields landed on the row.
    const lookup = await request.get(`${API}/wellness/visits?phone=${encodeURIComponent(phone)}`, {
      headers: authHdr(tokens.wellnessAdmin),
      timeout: REQUEST_TIMEOUT,
    });
    expect(lookup.status()).toBe(200);
    const visits = (await lookup.json());
    const arr = Array.isArray(visits) ? visits : (visits.visits || visits.data || []);
    const found = arr.find((v) => v.id === body.visit.id);
    expect(found, 'visit not reachable in admin view').toBeTruthy();
    expect(found.utmSource).toBe(utm.utmSource);
    expect(found.utmMedium).toBe(utm.utmMedium);
    expect(found.utmCampaign).toBe(utm.utmCampaign);
    expect(found.utmTerm).toBe(utm.utmTerm);
    expect(found.utmContent).toBe(utm.utmContent);
    expect(found.referrer).toBe(referrer);
  });

  test('bookingType lowercases tolerated (case-insensitive)', async ({ request }) => {
    test.skip(!wellnessServiceId, 'wellness service not seeded');
    test.skip(!tokens.wellnessAdmin, 'wellness admin login unavailable');
    await setSupportedTypes(request, wellnessServiceId, ['CLINIC_VISIT', 'VIDEO']);
    const phone = randomTestPhone();
    createdPatientPhones.push(phone);
    const r = await request.post(`${API}/wellness/public/book`, {
      data: {
        tenantSlug: 'enhanced-wellness',
        serviceId: wellnessServiceId,
        locationId: wellnessLocationId,
        name: `${RUN_TAG} LowerCase`,
        phone,
        bookingType: 'video', // lowercased
      },
      headers: { 'Content-Type': 'application/json' },
      timeout: REQUEST_TIMEOUT,
    });
    expect(r.status()).toBe(201);
    const body = await r.json();
    // Server normalizes to upper.
    expect(body.visit.bookingType).toBe('VIDEO');
    createdVisitIds.push(body.visit.id);
  });

  // ──────────────────────────────────────────────────────────────────
  // Service catalog admin: supportedBookingTypes accept/reject
  // ──────────────────────────────────────────────────────────────────

  test('PUT /wellness/services accepts supportedBookingTypes JSON array', async ({ request }) => {
    test.skip(!wellnessServiceId, 'wellness service not seeded');
    test.skip(!tokens.wellnessAdmin, 'wellness admin login unavailable');
    const r = await request.put(`${API}/wellness/services/${wellnessServiceId}`, {
      headers: authHdr(tokens.wellnessAdmin),
      data: { supportedBookingTypes: ['CLINIC_VISIT', 'IN_HOME', 'VIDEO'] },
      timeout: REQUEST_TIMEOUT,
    });
    expect(r.status()).toBe(200);
    // Read back via the public catalog (parses the JSON-string column).
    const profile = await request.get(`${API}/wellness/public/tenant/enhanced-wellness`, {
      timeout: REQUEST_TIMEOUT,
    });
    const body = await profile.json();
    const svc = (body.services || []).find((s) => s.id === wellnessServiceId);
    expect(svc, 'updated service should be visible on public catalog').toBeTruthy();
    expect(svc.supportedBookingTypes).toEqual(
      expect.arrayContaining(['CLINIC_VISIT', 'IN_HOME', 'VIDEO'])
    );
  });

  test('PUT /wellness/services rejects unknown bookingType in supportedBookingTypes', async ({ request }) => {
    test.skip(!wellnessServiceId, 'wellness service not seeded');
    test.skip(!tokens.wellnessAdmin, 'wellness admin login unavailable');
    const r = await request.put(`${API}/wellness/services/${wellnessServiceId}`, {
      headers: authHdr(tokens.wellnessAdmin),
      data: { supportedBookingTypes: ['CLINIC_VISIT', 'CARRIER_PIGEON'] },
      timeout: REQUEST_TIMEOUT,
    });
    expect(r.status()).toBe(400);
    const body = await r.json();
    expect(body.code).toBe('INVALID_INPUT');
    expect(String(body.error)).toMatch(/CARRIER_PIGEON/);
  });

  test('PUT /wellness/services rejects non-array supportedBookingTypes', async ({ request }) => {
    test.skip(!wellnessServiceId, 'wellness service not seeded');
    test.skip(!tokens.wellnessAdmin, 'wellness admin login unavailable');
    const r = await request.put(`${API}/wellness/services/${wellnessServiceId}`, {
      headers: authHdr(tokens.wellnessAdmin),
      data: { supportedBookingTypes: 'CLINIC_VISIT' }, // string, not array
      timeout: REQUEST_TIMEOUT,
    });
    expect(r.status()).toBe(400);
    const body = await r.json();
    expect(body.code).toBe('INVALID_INPUT');
  });
});
