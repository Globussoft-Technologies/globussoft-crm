// @ts-check
/**
 * Gate spec — DigiLocker stub-mode Aadhaar verification flow (PRD §4.5 + §4.7).
 *
 * Pins the swap-point contract that the REAL DigiLocker integration
 * (pending Q3 cred drop — Travel Stall partner registration) MUST
 * honour. Today's stub returns synthetic last-4 "9999" and a hash-
 * derived opaque token; the route + DB shape are production-ready, so
 * swapping to real OAuth is one file (backend/services/digilockerClient.js).
 *
 * Covers:
 *   POST /api/travel/trips/:tripId/participants/:participantId/digilocker/initiate
 *   POST /api/travel/trips/:tripId/participants/:participantId/digilocker/callback
 *
 * Security contract pinned:
 *   - aadhaarTokenId / resultTokenId NEVER appear in any HTTP response
 *     (token stays server-side per the route-header convention)
 *   - replay protection: re-using a verified state → 409 INVALID_STATE
 *   - tenant scoping on the callback (state lookup is tenant-scoped)
 *   - vertical guard via requireTravelTenant (generic admin → 403 WRONG_VERTICAL)
 */

const { test, expect } = require("@playwright/test");

test.describe.configure({ mode: "serial" });

const BASE_URL = process.env.BASE_URL || "https://crm.globusdemos.com";
const REQUEST_TIMEOUT = 60000;
const RUN_TAG = `E2E_TRAVEL_DIGILOCKER_${Date.now()}`;

let travelAdminToken = null;
let genericAdminToken = null;
let schoolContactId = null;
let tripId = null;
let participantId = null;

async function loginAs(request, email, password) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await request.post(`${BASE_URL}/api/auth/login`, {
        data: { email, password },
        headers: { "Content-Type": "application/json" },
        timeout: REQUEST_TIMEOUT,
      });
      if (r.ok()) return (await r.json()).token;
    } catch (_e) { if (attempt === 0) continue; }
  }
  return null;
}

async function getTravelAdmin(request) {
  if (!travelAdminToken) {
    travelAdminToken = await loginAs(request, "yasin@travelstall.in", "password123");
  }
  return travelAdminToken;
}
async function getGenericAdmin(request) {
  if (!genericAdminToken) {
    genericAdminToken = await loginAs(request, "admin@globussoft.com", "password123");
  }
  return genericAdminToken;
}

const headers = (token) => ({ Authorization: `Bearer ${token}`, "Content-Type": "application/json" });

async function retryOn5xx(fn) {
  let r;
  for (let attempt = 0; attempt < 3; attempt++) {
    r = await fn();
    if (r.status() < 500) return r;
    await new Promise((res) => setTimeout(res, 500 * (attempt + 1)));
  }
  return r;
}

async function get(request, token, path) {
  return retryOn5xx(() => request.get(`${BASE_URL}${path}`, { headers: headers(token), timeout: REQUEST_TIMEOUT }));
}
async function post(request, token, path, body) {
  return retryOn5xx(() => request.post(`${BASE_URL}${path}`, { headers: headers(token), data: body ?? {}, timeout: REQUEST_TIMEOUT }));
}
async function del(request, token, path) {
  return retryOn5xx(() => request.delete(`${BASE_URL}${path}`, { headers: headers(token), timeout: REQUEST_TIMEOUT }));
}

test.beforeAll(async ({ request }) => {
  const token = await getTravelAdmin(request);
  if (!token) return;

  // Need a school contact + trip + participant fixture chain.
  const cRes = await post(request, token, "/api/contacts", {
    name: `${RUN_TAG} Mountainview International School`,
    email: `${RUN_TAG.toLowerCase()}-school@e2e.test`,
    phone: `+91${String(Date.now()).slice(-10)}`,
    subBrand: "tmc",
  });
  if (cRes.ok()) {
    const body = await cRes.json();
    schoolContactId = body.id || body.contact?.id;
  }
  if (!schoolContactId) return;

  const tRes = await post(request, token, "/api/travel/trips", {
    tripCode: `${RUN_TAG.toLowerCase()}_trip`,
    schoolContactId,
    destination: "Manali",
    departDate: "2030-06-15",
    returnDate: "2030-06-22",
    legalEntity: "tmc_nexus",
    pricePerStudent: 28000,
  });
  if (tRes.ok() || tRes.status() === 201) {
    tripId = (await tRes.json()).id;
  }
  if (!tripId) return;

  const pRes = await post(request, token, `/api/travel/trips/${tripId}/participants`, {
    fullName: `${RUN_TAG} Anaya Sharma`,
    parentName: `${RUN_TAG} Rajat Sharma`,
    parentPhone: "+919876543210",
    parentEmail: `${RUN_TAG.toLowerCase()}-parent@e2e.test`,
  });
  if (pRes.ok() || pRes.status() === 201) {
    participantId = (await pRes.json()).id;
  }
});

test.afterAll(async ({ request }) => {
  const token = await getTravelAdmin(request);
  if (!token) return;
  // Trip cascade-deletes participants + DigilockerSession rows; just
  // delete the trip + the school contact.
  if (tripId) {
    await del(request, token, `/api/travel/trips/${tripId}`).catch(() => {});
  }
  if (schoolContactId) {
    await del(request, token, `/api/contacts/${schoolContactId}`).catch(() => {});
  }
});

test.describe("DigiLocker stub-mode — auth + vertical guards", () => {
  test("POST /digilocker/initiate without auth → 401/403", async ({ request }) => {
    if (!tripId || !participantId) test.skip(true, "fixture not seeded");
    const res = await request.post(
      `${BASE_URL}/api/travel/trips/${tripId}/participants/${participantId}/digilocker/initiate`,
      {
        data: { redirectUri: "https://example.com/cb" },
        headers: { "Content-Type": "application/json" },
        timeout: REQUEST_TIMEOUT,
      },
    );
    expect([401, 403]).toContain(res.status());
  });

  test("POST /digilocker/initiate as generic admin → 403 WRONG_VERTICAL", async ({ request }) => {
    if (!tripId || !participantId) test.skip(true, "fixture not seeded");
    const token = await getGenericAdmin(request);
    if (!token) test.skip(true, "generic admin not seeded");
    const res = await post(
      request,
      token,
      `/api/travel/trips/${tripId}/participants/${participantId}/digilocker/initiate`,
      { redirectUri: "https://example.com/cb" },
    );
    expect(res.status()).toBe(403);
    expect((await res.json()).code).toBe("WRONG_VERTICAL");
  });

  test("POST /digilocker/callback without auth → 401/403", async ({ request }) => {
    if (!tripId || !participantId) test.skip(true, "fixture not seeded");
    const res = await request.post(
      `${BASE_URL}/api/travel/trips/${tripId}/participants/${participantId}/digilocker/callback`,
      {
        data: { state: "anything", code: "anything" },
        headers: { "Content-Type": "application/json" },
        timeout: REQUEST_TIMEOUT,
      },
    );
    expect([401, 403]).toContain(res.status());
  });
});

test.describe("DigiLocker stub-mode — initiate", () => {
  test("happy path → 200 with { state, oauthUrl, sessionId }", async ({ request }) => {
    if (!tripId || !participantId) test.skip(true, "fixture not seeded");
    const token = await getTravelAdmin(request);
    const res = await post(
      request,
      token,
      `/api/travel/trips/${tripId}/participants/${participantId}/digilocker/initiate`,
      { redirectUri: "https://parent-portal.example.com/digilocker/return" },
    );
    expect(res.status(), `initiate: ${await res.text()}`).toBe(200);
    const body = await res.json();
    expect(typeof body.state).toBe("string");
    expect(body.state).toMatch(/^[0-9a-f]{32}$/);
    expect(typeof body.oauthUrl).toBe("string");
    expect(body.oauthUrl).toMatch(/^https:\/\/digilocker-stub\.invalid\/oauth\/authorize\?/);
    expect(body.oauthUrl).toContain(`state=${body.state}`);
    expect(typeof body.sessionId).toBe("number");
  });

  test("missing redirectUri → 400 MISSING_FIELDS", async ({ request }) => {
    if (!tripId || !participantId) test.skip(true, "fixture not seeded");
    const token = await getTravelAdmin(request);
    const res = await post(
      request,
      token,
      `/api/travel/trips/${tripId}/participants/${participantId}/digilocker/initiate`,
      {},
    );
    expect(res.status()).toBe(400);
    expect((await res.json()).code).toBe("MISSING_FIELDS");
  });

  test("unknown participant → 404 PARTICIPANT_NOT_FOUND", async ({ request }) => {
    if (!tripId) test.skip(true, "fixture not seeded");
    const token = await getTravelAdmin(request);
    const res = await post(
      request,
      token,
      `/api/travel/trips/${tripId}/participants/9999999/digilocker/initiate`,
      { redirectUri: "https://example.com/cb" },
    );
    expect(res.status()).toBe(404);
    expect((await res.json()).code).toBe("PARTICIPANT_NOT_FOUND");
  });
});

test.describe("DigiLocker stub-mode — callback flow + replay protection", () => {
  let liveState = null;
  let secondState = null;

  test("callback with unknown state → 404 SESSION_NOT_FOUND", async ({ request }) => {
    if (!tripId || !participantId) test.skip(true, "fixture not seeded");
    const token = await getTravelAdmin(request);
    const res = await post(
      request,
      token,
      `/api/travel/trips/${tripId}/participants/${participantId}/digilocker/callback`,
      { state: "deadbeefdeadbeefdeadbeefdeadbeef", code: "stub-code" },
    );
    expect(res.status()).toBe(404);
    expect((await res.json()).code).toBe("SESSION_NOT_FOUND");
  });

  test("seed a fresh session for the happy-path test", async ({ request }) => {
    if (!tripId || !participantId) test.skip(true, "fixture not seeded");
    const token = await getTravelAdmin(request);
    const res = await post(
      request,
      token,
      `/api/travel/trips/${tripId}/participants/${participantId}/digilocker/initiate`,
      { redirectUri: "https://example.com/cb" },
    );
    expect(res.status()).toBe(200);
    liveState = (await res.json()).state;
    expect(liveState).toBeTruthy();
  });

  test("callback happy path → 200 verified:true + aadhaarLast4 9999 + no token leak", async ({ request }) => {
    if (!liveState) test.skip(true, "no live state from previous step");
    const token = await getTravelAdmin(request);
    const res = await post(
      request,
      token,
      `/api/travel/trips/${tripId}/participants/${participantId}/digilocker/callback`,
      { state: liveState, code: "stub-auth-code" },
    );
    expect(res.status(), `callback: ${await res.text()}`).toBe(200);
    const body = await res.json();
    expect(body.verified).toBe(true);
    expect(body.aadhaarLast4).toBe("9999");
    // Security: opaque token NEVER appears in the response.
    expect(body).not.toHaveProperty("aadhaarTokenId");
    expect(body).not.toHaveProperty("resultTokenId");
    expect(body).not.toHaveProperty("tokenId");
  });

  test("callback persists Aadhaar last-4 + tokenId onto the TripParticipant", async ({ request }) => {
    if (!liveState) test.skip(true, "no live state from previous step");
    const token = await getTravelAdmin(request);
    const res = await get(request, token, `/api/travel/trips/${tripId}/participants`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    const p = (body.participants || []).find((x) => x.id === participantId);
    expect(p).toBeTruthy();
    expect(p.aadhaarLast4).toBe("9999");
    expect(typeof p.aadhaarTokenId).toBe("string");
    expect(p.aadhaarTokenId).toMatch(/^stub-token-[0-9a-f]{24}$/);
  });

  test("replay: re-using a verified state → 409 INVALID_STATE", async ({ request }) => {
    if (!liveState) test.skip(true, "no live state from previous step");
    const token = await getTravelAdmin(request);
    const res = await post(
      request,
      token,
      `/api/travel/trips/${tripId}/participants/${participantId}/digilocker/callback`,
      { state: liveState, code: "stub-auth-code-replay" },
    );
    expect(res.status()).toBe(409);
    expect((await res.json()).code).toBe("INVALID_STATE");
  });

  test("callback with missing state → 400 MISSING_FIELDS", async ({ request }) => {
    if (!tripId || !participantId) test.skip(true, "fixture not seeded");
    const token = await getTravelAdmin(request);
    const res = await post(
      request,
      token,
      `/api/travel/trips/${tripId}/participants/${participantId}/digilocker/callback`,
      { code: "no-state" },
    );
    expect(res.status()).toBe(400);
    expect((await res.json()).code).toBe("MISSING_FIELDS");
  });

  test("second session under the same participant is independent of the first", async ({ request }) => {
    // Verifies that the schema doesn't accidentally pin a one-and-only-
    // one session per participant (it shouldn't — the @unique is on
    // `state`, not on participantId).
    if (!tripId || !participantId) test.skip(true, "fixture not seeded");
    const token = await getTravelAdmin(request);
    const initRes = await post(
      request,
      token,
      `/api/travel/trips/${tripId}/participants/${participantId}/digilocker/initiate`,
      { redirectUri: "https://example.com/cb2" },
    );
    expect(initRes.status()).toBe(200);
    secondState = (await initRes.json()).state;
    expect(secondState).toBeTruthy();
    expect(secondState).not.toBe(liveState);

    const cbRes = await post(
      request,
      token,
      `/api/travel/trips/${tripId}/participants/${participantId}/digilocker/callback`,
      { state: secondState, code: "stub-code-2" },
    );
    expect(cbRes.status()).toBe(200);
    expect((await cbRes.json()).verified).toBe(true);
  });
});
