// @ts-check
/**
 * Gate spec — POST /api/travel/trips/:tripId/instalments/from-plan
 *
 * Materialiser that expands TripPaymentPlan.instalmentsJson × the trip's
 * participant roster into TripInstalmentPayment rows. Idempotent on
 * (tripId, participantId, instalmentIndex).
 *
 * Pins:
 *   - happy path  (3 participants × 4 instalments = 12 created, 0 skipped)
 *   - 404 NO_PLAN when the trip has no payment plan
 *   - 400 EMPTY_ROSTER when the trip has no participants
 *   - re-run idempotency — second call on unchanged state creates 0;
 *     adding a participant + re-run only creates the new participant's rows
 *   - 401 without an Authorization header
 *
 * Auth gates match the sibling per-trip endpoints in travel_trip_billing.js
 * (verifyToken + requirePermission("trips","write") + requireTravelTenant
 * + requireTmcAccess) — exercised here via the happy-path travel-admin
 * token + a bare 401 probe.
 */

const { test, expect } = require("@playwright/test");

test.describe.configure({ mode: "serial", timeout: 120_000 });

const BASE_URL = process.env.BASE_URL || "https://crm.globusdemos.com";
const REQUEST_TIMEOUT = 60000;
const RUN_TAG = `E2E_TRAVEL_FROMPLAN_${Date.now()}`;

let travelAdminToken = null;
let schoolContactId = null;

// Happy-path trip — has plan + 3 participants
let tripId = null;
const participantIds = [];

// Negative-case trips
let tripNoPlanId = null;
let tripNoRosterId = null;

async function loginAs(request, email, password) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await request.post(`${BASE_URL}/api/auth/login`, {
        data: { email, password },
        headers: { "Content-Type": "application/json" },
        timeout: REQUEST_TIMEOUT,
      });
      if (r.ok()) return (await r.json()).token;
    } catch (_e) {
      if (attempt === 0) continue;
    }
  }
  return null;
}

async function getTravelAdmin(request) {
  if (!travelAdminToken) {
    travelAdminToken = await loginAs(request, "yasin@travelstall.in", "password123");
  }
  return travelAdminToken;
}

const headers = (token) => ({
  Authorization: `Bearer ${token}`,
  "Content-Type": "application/json",
});

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
  return retryOn5xx(() =>
    request.get(`${BASE_URL}${path}`, { headers: headers(token), timeout: REQUEST_TIMEOUT }),
  );
}
async function post(request, token, path, body) {
  return retryOn5xx(() =>
    request.post(`${BASE_URL}${path}`, {
      headers: headers(token),
      data: body ?? {},
      timeout: REQUEST_TIMEOUT,
    }),
  );
}
async function put(request, token, path, body) {
  return retryOn5xx(() =>
    request.put(`${BASE_URL}${path}`, {
      headers: headers(token),
      data: body ?? {},
      timeout: REQUEST_TIMEOUT,
    }),
  );
}
async function del(request, token, path) {
  return retryOn5xx(() =>
    request.delete(`${BASE_URL}${path}`, {
      headers: headers(token),
      timeout: REQUEST_TIMEOUT,
    }),
  );
}

// Build a 4-instalment plan that's accepted by PUT /payment-plan (non-empty
// array, valid dueDate, numeric amount).
function buildPlan() {
  return JSON.stringify([
    { dueDate: "2026-08-01", amount: 5000, reminderDays: 7 },
    { dueDate: "2026-09-01", amount: 5000, reminderDays: 7 },
    { dueDate: "2026-10-01", amount: 5000, reminderDays: 3 },
    { dueDate: "2026-11-01", amount: 5000, reminderDays: 3 },
  ]);
}

test.beforeAll(async ({ request }) => {
  const token = await getTravelAdmin(request);
  if (!token) return;

  // School contact (shared across the 3 trips for cleanliness).
  const cRes = await post(request, token, "/api/contacts", {
    name: `${RUN_TAG} School`,
    email: `${RUN_TAG.toLowerCase()}-school@e2e.test`,
    phone: `+91${String(Date.now()).slice(-10)}`,
    subBrand: "tmc",
  });
  if (cRes.ok()) schoolContactId = (await cRes.json()).id;
  if (!schoolContactId) return;

  // Trip A — happy path. Plan + 3 participants.
  const tA = await post(request, token, "/api/travel/trips", {
    tripCode: `${RUN_TAG.toLowerCase()}_a`,
    schoolContactId,
    destination: `${RUN_TAG} A`,
    departDate: "2026-12-01",
    returnDate: "2026-12-07",
  });
  if (tA.ok()) tripId = (await tA.json()).id;
  if (!tripId) return;

  for (const name of ["Anika", "Bharat", "Chitra"]) {
    const p = await post(request, token, `/api/travel/trips/${tripId}/participants`, {
      fullName: `${RUN_TAG} ${name}`,
    });
    if (p.ok()) participantIds.push((await p.json()).id);
  }

  await put(request, token, `/api/travel/trips/${tripId}/payment-plan`, {
    instalmentsJson: buildPlan(),
    graceDays: 5,
  });

  // Trip B — has 1 participant, NO plan. For 404 NO_PLAN.
  const tB = await post(request, token, "/api/travel/trips", {
    tripCode: `${RUN_TAG.toLowerCase()}_b`,
    schoolContactId,
    destination: `${RUN_TAG} B`,
    departDate: "2026-12-01",
    returnDate: "2026-12-07",
  });
  if (tB.ok()) tripNoPlanId = (await tB.json()).id;
  if (tripNoPlanId) {
    await post(request, token, `/api/travel/trips/${tripNoPlanId}/participants`, {
      fullName: `${RUN_TAG} NoPlanKid`,
    });
  }

  // Trip C — has a plan, NO participants. For 400 EMPTY_ROSTER.
  const tC = await post(request, token, "/api/travel/trips", {
    tripCode: `${RUN_TAG.toLowerCase()}_c`,
    schoolContactId,
    destination: `${RUN_TAG} C`,
    departDate: "2026-12-01",
    returnDate: "2026-12-07",
  });
  if (tC.ok()) tripNoRosterId = (await tC.json()).id;
  if (tripNoRosterId) {
    await put(request, token, `/api/travel/trips/${tripNoRosterId}/payment-plan`, {
      instalmentsJson: buildPlan(),
      graceDays: 0,
    });
  }
});

test.afterAll(async ({ request }) => {
  const token = await getTravelAdmin(request);
  if (!token) return;
  for (const id of [tripId, tripNoPlanId, tripNoRosterId]) {
    if (id) await del(request, token, `/api/travel/trips/${id}`).catch(() => {});
  }
  if (schoolContactId) await del(request, token, `/api/contacts/${schoolContactId}`).catch(() => {});
});

test.describe("Travel trip billing — POST /instalments/from-plan", () => {
  test("401 when called without an Authorization header", async ({ request }) => {
    test.skip(!tripId, "setup incomplete");
    const r = await retryOn5xx(() =>
      request.post(`${BASE_URL}/api/travel/trips/${tripId}/instalments/from-plan`, {
        data: {},
        headers: { "Content-Type": "application/json" },
        timeout: REQUEST_TIMEOUT,
      }),
    );
    expect(r.status()).toBe(401);
  });

  test("404 NO_PLAN when the trip has no payment plan", async ({ request }) => {
    const token = await getTravelAdmin(request);
    test.skip(!token || !tripNoPlanId, "setup incomplete");
    const r = await post(request, token, `/api/travel/trips/${tripNoPlanId}/instalments/from-plan`);
    expect(r.status()).toBe(404);
    const body = await r.json();
    expect(body.code).toBe("NO_PLAN");
  });

  test("400 EMPTY_ROSTER when the trip has a plan but no participants", async ({ request }) => {
    const token = await getTravelAdmin(request);
    test.skip(!token || !tripNoRosterId, "setup incomplete");
    const r = await post(request, token, `/api/travel/trips/${tripNoRosterId}/instalments/from-plan`);
    expect(r.status()).toBe(400);
    const body = await r.json();
    expect(body.code).toBe("EMPTY_ROSTER");
  });

  test("happy path — 3 participants × 4 instalments creates 12 rows", async ({ request }) => {
    const token = await getTravelAdmin(request);
    test.skip(!token || !tripId || participantIds.length !== 3, "setup incomplete");

    const r = await post(request, token, `/api/travel/trips/${tripId}/instalments/from-plan`);
    expect(r.status()).toBe(201);
    const body = await r.json();
    expect(body.materialised).toBe(12);
    expect(body.skipped).toBe(0);
    expect(body.participants).toBe(3);
    expect(body.instalmentsPerParticipant).toBe(4);

    // Verify rows are queryable through the list endpoint and shape-correct.
    const list = await get(request, token, `/api/travel/trips/${tripId}/instalments`);
    expect(list.status()).toBe(200);
    const listed = (await list.json()).instalments;
    expect(listed.length).toBe(12);
    for (const row of listed) {
      expect(row.tripId).toBe(tripId);
      expect(participantIds).toContain(row.participantId);
      expect(row.status).toBe("pending");
      expect(Number(row.paidAmount)).toBe(0);
      expect(row.paidAt).toBeNull();
      expect([0, 1, 2, 3]).toContain(row.instalmentIndex);
    }
  });

  test("re-run is idempotent — second call creates 0 and skips all 12", async ({ request }) => {
    const token = await getTravelAdmin(request);
    test.skip(!token || !tripId, "setup incomplete");

    const r = await post(request, token, `/api/travel/trips/${tripId}/instalments/from-plan`);
    expect(r.status()).toBe(201);
    const body = await r.json();
    expect(body.materialised).toBe(0);
    expect(body.skipped).toBe(12);
    expect(body.participants).toBe(3);
    expect(body.instalmentsPerParticipant).toBe(4);

    // Ledger size should not have grown.
    const list = await get(request, token, `/api/travel/trips/${tripId}/instalments`);
    expect(((await list.json()).instalments || []).length).toBe(12);
  });

  test("adding a participant + re-run creates only the new participant's 4 rows", async ({ request }) => {
    const token = await getTravelAdmin(request);
    test.skip(!token || !tripId, "setup incomplete");

    const newP = await post(request, token, `/api/travel/trips/${tripId}/participants`, {
      fullName: `${RUN_TAG} Dilip`,
    });
    expect(newP.ok()).toBeTruthy();
    const newParticipantId = (await newP.json()).id;
    participantIds.push(newParticipantId);

    const r = await post(request, token, `/api/travel/trips/${tripId}/instalments/from-plan`);
    expect(r.status()).toBe(201);
    const body = await r.json();
    expect(body.materialised).toBe(4);
    expect(body.skipped).toBe(12);
    expect(body.participants).toBe(4);
    expect(body.instalmentsPerParticipant).toBe(4);

    // Only the new participant's 4 rows landed; the prior 12 are untouched.
    const list = await get(request, token, `/api/travel/trips/${tripId}/instalments`);
    const listed = (await list.json()).instalments;
    expect(listed.length).toBe(16);
    const newOnes = listed.filter((row) => row.participantId === newParticipantId);
    expect(newOnes.length).toBe(4);
    for (const row of newOnes) {
      expect(row.status).toBe("pending");
      expect([0, 1, 2, 3]).toContain(row.instalmentIndex);
    }
  });
});
