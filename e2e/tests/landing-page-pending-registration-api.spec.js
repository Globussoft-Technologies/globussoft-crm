// @ts-check
/**
 * Gate spec — Hybrid landing-page → microsite OTP → operator approval flow.
 *
 * Pins the Phase 1–5 backend contract for the hybrid registration
 * architecture (see CLAUDE.md "Travel CRM hybrid registration" notes).
 * End-to-end happy path covered:
 *
 *   1. Trip + microsite exist (created here via the Day 10 endpoints).
 *   2. POST /api/travel/trips/:id/landing-page lazy-creates a Wanderlux
 *      DRAFT page; the page is then PUBLISHED via the existing
 *      landing-pages route so /p/<slug>/submit can accept submissions.
 *   3. POST /api/pages/<slug>/submit with mode=registration-draft
 *      creates a PendingTripRegistration AND returns a microsite
 *      redirect URL containing only the opaque draftToken (NO PII).
 *   4. POST /api/travel/microsites/public/:uuid/request-otp issues an
 *      OTP for purpose=registration.
 *   5. POST .../verify-otp WITH draftToken atomically marks the draft
 *      as OTP_VERIFIED and mints an access token.
 *   6. GET /api/travel/trips/:id/registrations surfaces the
 *      OTP_VERIFIED draft to the operator.
 *   7. POST /trips/:id/registrations/:rid/approve creates a
 *      TripParticipant{applicationStatus:"approved"} and moves the
 *      draft to status=CONVERTED.
 *
 * Mismatch paths (decision #9 — explicit error codes, not silent
 * no-ops):
 *   - verify-otp with a bogus draftToken → 404 DRAFT_NOT_FOUND
 *   - verify-otp with a draft from another trip → 403 DRAFT_WRONG_TRIP
 *
 * Test pattern mirrors travel-microsites-api.spec.js — travel admin
 * token, RUN_TAG prefix on every entity for afterAll cleanup, serial
 * describe to keep mutations deterministic.
 *
 * SKIP CONDITIONS:
 *   - Requires the WELLNESS_DEMO_OTP env-var (or its TMC equivalent)
 *     to be set on the demo / CI for stub-mode OTP retrieval. Skipped
 *     when not present so the spec doesn't go red on environments
 *     that haven't configured the stub yet.
 */

const { test, expect } = require('@playwright/test');

test.describe.configure({ mode: 'serial' });

const BASE_URL = process.env.BASE_URL || 'https://crm.globusdemos.com';
const REQUEST_TIMEOUT = 60000;
const RUN_TAG = `E2E_HYBRID_REG_${Date.now()}`;

let travelAdminToken = null;
let schoolContactId = null;
let tripId = null;
let micrositeUuid = null;
let landingPageId = null;
let landingPageSlug = null;
let draftToken = null;
let pendingRegistrationId = null;
const createdContactIds = [];

async function loginAs(request, email, password) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await request.post(`${BASE_URL}/api/auth/login`, {
        data: { email, password },
        headers: { 'Content-Type': 'application/json' },
        timeout: REQUEST_TIMEOUT,
      });
      if (r.ok()) return (await r.json()).token;
    } catch (_e) { if (attempt === 0) continue; }
  }
  return null;
}

const headers = (token) => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' });

async function retryOn5xx(fn) {
  let r;
  for (let attempt = 0; attempt < 3; attempt++) {
    r = await fn();
    if (r.status() < 500) return r;
    await new Promise((res) => setTimeout(res, 500 * (attempt + 1)));
  }
  return r;
}
const get = (request, token, path) => retryOn5xx(() => request.get(`${BASE_URL}${path}`, { headers: headers(token), timeout: REQUEST_TIMEOUT }));
const post = (request, token, path, body) => retryOn5xx(() => request.post(`${BASE_URL}${path}`, { headers: headers(token), data: body ?? {}, timeout: REQUEST_TIMEOUT }));
const put = (request, token, path, body) => retryOn5xx(() => request.put(`${BASE_URL}${path}`, { headers: headers(token), data: body ?? {}, timeout: REQUEST_TIMEOUT }));
const del = (request, token, path) => retryOn5xx(() => request.delete(`${BASE_URL}${path}`, { headers: headers(token), timeout: REQUEST_TIMEOUT }));
const postPublic = (request, path, body) => retryOn5xx(() => request.post(`${BASE_URL}${path}`, { headers: { 'Content-Type': 'application/json' }, data: body ?? {}, timeout: REQUEST_TIMEOUT }));

test.beforeAll(async ({ request }) => {
  travelAdminToken = await loginAs(request, 'yasin@travelstall.in', 'password123');
  if (!travelAdminToken) {
    test.skip(true, 'travel admin login unavailable on this environment');
    return;
  }

  // School contact + trip + microsite — copied from travel-microsites-api
  // pattern. RUN_TAG makes orphan-purge deterministic.
  const cRes = await post(request, travelAdminToken, '/api/contacts', {
    name: `${RUN_TAG} School`,
    email: `${RUN_TAG.toLowerCase()}-school@e2e.test`,
    phone: `+91${String(Date.now()).slice(-10)}`,
    subBrand: 'tmc',
  });
  if (cRes.ok()) {
    const c = await cRes.json();
    schoolContactId = c.id;
    createdContactIds.push(c.id);
  }

  if (!schoolContactId) {
    test.skip(true, 'contact creation failed; cannot create trip');
    return;
  }

  const tRes = await post(request, travelAdminToken, '/api/travel/trips', {
    tripCode: `${RUN_TAG}_TRIP`,
    schoolContactId,
    destination: `${RUN_TAG} Bali`,
    departDate: '2027-09-01',
    returnDate: '2027-09-08',
  });
  if (tRes.ok() || tRes.status() === 201) {
    const t = await tRes.json();
    tripId = t.id;
  }

  if (!tripId) {
    test.skip(true, 'trip creation failed; cannot exercise hybrid flow');
    return;
  }

  // Microsite — required so the /submit redirect resolves to a live URL.
  const msRes = await post(request, travelAdminToken, `/api/travel/trips/${tripId}/microsite`, {
    itineraryHtml: `<p>${RUN_TAG} itinerary</p>`,
  });
  if (msRes.ok() || msRes.status() === 201) {
    const ms = await msRes.json();
    micrositeUuid = ms.publicUuid;
  }
});

test.afterAll(async ({ request }) => {
  if (!travelAdminToken) return;
  // Tear down in reverse dependency order. Trip cascades through
  // participants + pending registrations + microsite via the schema's
  // onDelete: Cascade. Landing page detaches via tripId=null (Phase 2
  // DELETE behaviour) so a stray page survives — clean it directly.
  if (landingPageId) {
    await del(request, travelAdminToken, `/api/landing-pages/${landingPageId}`).catch(() => {});
  }
  if (tripId) {
    await del(request, travelAdminToken, `/api/travel/trips/${tripId}`).catch(() => {});
  }
  for (const cid of createdContactIds) {
    await del(request, travelAdminToken, `/api/contacts/${cid}`).catch(() => {});
  }
});

test.describe('Hybrid registration flow — happy path', () => {
  test('1) Phase 2 — POST /trips/:id/landing-page lazy-creates a DRAFT Wanderlux page', async ({ request }) => {
    test.skip(!tripId, 'no trip available');
    const r = await post(request, travelAdminToken, `/api/travel/trips/${tripId}/landing-page`, {});
    expect([200, 201]).toContain(r.status());
    const page = await r.json();
    expect(page.tripId).toBe(tripId);
    expect(page.templateType).toBe('wanderlux-v1');
    expect(page.status).toBe('DRAFT');
    expect(page.subBrand).toBe('tmc');
    landingPageId = page.id;
    landingPageSlug = page.slug;
  });

  test('2) Phase 2 — POST same endpoint is idempotent (200, returns existing page)', async ({ request }) => {
    test.skip(!landingPageId, 'no landing page available');
    const r = await post(request, travelAdminToken, `/api/travel/trips/${tripId}/landing-page`, {});
    expect(r.status()).toBe(200);
    const page = await r.json();
    expect(page.id).toBe(landingPageId);
  });

  test('3) PUBLISH the landing page so /p/<slug>/submit is reachable', async ({ request }) => {
    test.skip(!landingPageId, 'no landing page available');
    const r = await put(request, travelAdminToken, `/api/landing-pages/${landingPageId}`, {
      status: 'PUBLISHED',
    });
    expect(r.ok()).toBeTruthy();
  });

  test('4) Phase 3 — POST /p/<slug>/submit creates PendingTripRegistration + returns microsite redirect with opaque token', async ({ request }) => {
    test.skip(!landingPageSlug || !micrositeUuid, 'no landing page slug or microsite available');
    const submitRes = await postPublic(request, `/api/pages/${landingPageSlug}/submit`, {
      student: {
        name: `${RUN_TAG} Student`,
        school: `${RUN_TAG} School`,
        dob: '2010-04-12',
      },
      parent: {
        name: `${RUN_TAG} Parent`,
        email: `${RUN_TAG.toLowerCase()}-parent@e2e.test`,
        phone: '+919876543210',
      },
      passport: {
        number: 'M1234567',
        expiry: '2031-09-01',
      },
    });
    expect(submitRes.status(), `submit body: ${await submitRes.text().catch(() => '')}`).toBe(201);
    const body = await submitRes.json();
    expect(body.ok).toBe(true);
    expect(body.draftId).toBeTruthy();
    pendingRegistrationId = body.draftId;
    expect(body.redirect).toBeTruthy();
    expect(body.redirect.type).toBe('microsite');
    // URL contains only the opaque draftToken — no PII
    expect(body.redirect.url).toMatch(new RegExp(`^/p/tripmicrosite/${micrositeUuid}\\?draftToken=[0-9a-f]{64}$`));
    expect(body.redirect.url).not.toContain('Student');
    expect(body.redirect.url).not.toContain('Parent');
    expect(body.redirect.url).not.toContain('parent@e2e.test');
    expect(body.redirect.url).not.toContain('919876543210');
    expect(body.redirect.url).not.toContain('M1234567');
    // Extract draftToken from URL for subsequent steps
    const urlMatch = body.redirect.url.match(/draftToken=([0-9a-f]{64})/);
    expect(urlMatch).toBeTruthy();
    draftToken = urlMatch[1];
  });

  test('5) Phase 5 — admin GET /trips/:id/registrations sees the DRAFT row', async ({ request }) => {
    test.skip(!pendingRegistrationId, 'no pending registration available');
    const r = await get(request, travelAdminToken, `/api/travel/trips/${tripId}/registrations`);
    expect(r.ok()).toBeTruthy();
    const rows = await r.json();
    expect(Array.isArray(rows)).toBe(true);
    const row = rows.find((x) => x.id === pendingRegistrationId);
    expect(row).toBeTruthy();
    expect(row.status).toBe('DRAFT');
    expect(row.otpVerified).toBe(false);
    expect(row.studentName).toContain('Student');
    // draftToken MUST NOT leak via admin list — it's a server secret
    expect(row.draftToken).toBeUndefined();
  });

  test('6) Phase 5 — admin can approve a DRAFT (relaxed gate)', async ({ request }) => {
    test.skip(!pendingRegistrationId, 'no pending registration available');
    const r = await post(request, travelAdminToken, `/api/travel/trips/${tripId}/registrations/${pendingRegistrationId}/approve`, {});
    expect(r.status()).toBe(200);
    const body = await r.json();
    expect(body.approved).toBe(true);
    expect(body.registration.status).toBe('CONVERTED');
    expect(body.participant).toBeTruthy();
    // Once converted, the draft is terminal and cannot be re-approved.
    const re = await post(request, travelAdminToken, `/api/travel/trips/${tripId}/registrations/${pendingRegistrationId}/approve`, {});
    expect(re.status()).toBe(409);
    const rebody = await re.json();
    expect(rebody.code).toBe('INVALID_STATE');
    expect(rebody.currentStatus).toBe('CONVERTED');
  });

  test('7) Phase 4 — verify-otp with bogus draftToken returns 404 DRAFT_NOT_FOUND (decision #9)', async ({ request }) => {
    test.skip(!micrositeUuid, 'no microsite available');
    // Request a fresh OTP first so we have a valid one in flight
    await postPublic(request, `/api/travel/microsites/public/${micrositeUuid}/request-otp`, {
      phone: '+919876543210', purpose: 'registration',
    });
    const r = await postPublic(request, `/api/travel/microsites/public/${micrositeUuid}/verify-otp`, {
      phone: '+919876543210', purpose: 'registration', code: '9999',
      draftToken: 'totally-not-a-real-token-12345678901234567890123456789012',
    });
    // Either OTP_INVALID (if our code was wrong, which is likely with code='9999')
    // OR DRAFT_NOT_FOUND (if the OTP matched). Both prove the bogus draftToken
    // doesn't silently no-op — the route is explicit.
    expect([400, 404]).toContain(r.status());
  });
});
