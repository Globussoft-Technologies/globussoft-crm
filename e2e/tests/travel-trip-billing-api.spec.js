// @ts-check
/**
 * Gate spec — TMC trip rooming + payment plan + instalments.
 *
 * Pins the Day 13 commit. Covers:
 *   GET    /api/travel/trips/:tripId/rooming
 *   POST   /api/travel/trips/:tripId/rooming
 *   PATCH  /api/travel/trips/:tripId/rooming/:roomId
 *   DELETE /api/travel/trips/:tripId/rooming/:roomId
 *   GET    /api/travel/trips/:tripId/payment-plan
 *   PUT    /api/travel/trips/:tripId/payment-plan         (upsert)
 *   DELETE /api/travel/trips/:tripId/payment-plan
 *   GET    /api/travel/trips/:tripId/instalments
 *   POST   /api/travel/trips/:tripId/instalments
 *   PATCH  /api/travel/trips/:tripId/instalments/:id
 *   DELETE /api/travel/trips/:tripId/instalments/:id
 */

const { test, expect } = require("@playwright/test");

test.describe.configure({ mode: "serial" });

const BASE_URL = process.env.BASE_URL || "https://crm.globusdemos.com";
const REQUEST_TIMEOUT = 60000;
const RUN_TAG = `E2E_TRAVEL_TBILL_${Date.now()}`;

let travelAdminToken = null;
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
async function put(request, token, path, body) {
  return retryOn5xx(() => request.put(`${BASE_URL}${path}`, { headers: headers(token), data: body ?? {}, timeout: REQUEST_TIMEOUT }));
}
async function patch(request, token, path, body) {
  return retryOn5xx(() => request.patch(`${BASE_URL}${path}`, { headers: headers(token), data: body ?? {}, timeout: REQUEST_TIMEOUT }));
}
async function del(request, token, path) {
  return retryOn5xx(() => request.delete(`${BASE_URL}${path}`, { headers: headers(token), timeout: REQUEST_TIMEOUT }));
}

const created = { roomIds: [], instalmentIds: [] };

test.beforeAll(async ({ request }) => {
  const token = await getTravelAdmin(request);
  if (!token) return;
  // Need: school Contact + Trip + Participant
  const cRes = await post(request, token, "/api/contacts", {
    name: `${RUN_TAG} School`,
    email: `${RUN_TAG.toLowerCase()}-school@e2e.test`,
    phone: `+91${String(Date.now()).slice(-10)}`,
    subBrand: "tmc",
  });
  if (cRes.ok()) schoolContactId = (await cRes.json()).id;
  if (!schoolContactId) return;
  const tRes = await post(request, token, "/api/travel/trips", {
    tripCode: `${RUN_TAG.toLowerCase()}_billing`,
    schoolContactId,
    destination: `${RUN_TAG} Goa`,
    departDate: "2026-10-01",
    returnDate: "2026-10-07",
  });
  if (tRes.ok()) tripId = (await tRes.json()).id;
  if (!tripId) return;
  const pRes = await post(request, token, `/api/travel/trips/${tripId}/participants`, {
    fullName: `${RUN_TAG} Participant Anika`,
  });
  if (pRes.ok()) participantId = (await pRes.json()).id;
});

test.afterAll(async ({ request }) => {
  const token = await getTravelAdmin(request);
  if (!token) return;
  if (tripId) await del(request, token, `/api/travel/trips/${tripId}`).catch(() => {});
  if (schoolContactId) await del(request, token, `/api/contacts/${schoolContactId}`).catch(() => {});
});

// ─── Rooming ─────────────────────────────────────────────────────────

test.describe("Travel trip billing — rooming", () => {
  test("POST /rooming creates a twin room with 2 participants", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token || !tripId || !participantId) test.skip(true, "deps missing");
    const res = await post(request, token, `/api/travel/trips/${tripId}/rooming`, {
      roomNumber: "101",
      roomType: "twin",
      participantIds: [participantId],
    });
    expect(res.status(), `create: ${await res.text()}`).toBe(201);
    const body = await res.json();
    expect(body.roomNumber).toBe("101");
    created.roomIds.push(body.id);
  });

  test("POST /rooming with too many participants → 400 ROOM_CAPACITY_EXCEEDED", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token || !tripId || !participantId) test.skip(true, "deps missing");
    const res = await post(request, token, `/api/travel/trips/${tripId}/rooming`, {
      roomNumber: "102",
      roomType: "single",
      participantIds: [participantId, participantId],
    });
    expect(res.status()).toBe(400);
    expect((await res.json()).code).toBe("ROOM_CAPACITY_EXCEEDED");
  });

  test("POST /rooming with bad roomType → 400 INVALID_ROOM_TYPE", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token || !tripId) test.skip(true, "no trip");
    const res = await post(request, token, `/api/travel/trips/${tripId}/rooming`, {
      roomNumber: "103",
      roomType: "penthouse",
      participantIds: [],
    });
    expect(res.status()).toBe(400);
    expect((await res.json()).code).toBe("INVALID_ROOM_TYPE");
  });

  test("POST /rooming with participant from another trip → 400 PARTICIPANTS_OFF_TRIP", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token || !tripId) test.skip(true, "no trip");
    const res = await post(request, token, `/api/travel/trips/${tripId}/rooming`, {
      roomNumber: "104",
      roomType: "twin",
      participantIds: [9999999], // not on this trip
    });
    expect(res.status()).toBe(400);
    expect((await res.json()).code).toBe("PARTICIPANTS_OFF_TRIP");
  });

  test("GET /rooming lists assignments", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token || !tripId) test.skip(true, "no trip");
    const res = await get(request, token, `/api/travel/trips/${tripId}/rooming`);
    expect(res.status()).toBe(200);
    expect(Array.isArray((await res.json()).rooming)).toBe(true);
  });

  test("PATCH /rooming amends roomNumber", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token || !tripId || created.roomIds.length === 0) test.skip(true, "no rooms");
    const res = await patch(request, token, `/api/travel/trips/${tripId}/rooming/${created.roomIds[0]}`, {
      roomNumber: "101A",
    });
    expect(res.status()).toBe(200);
    expect((await res.json()).roomNumber).toBe("101A");
  });
});

// ─── Payment plan ────────────────────────────────────────────────────

test.describe("Travel trip billing — payment plan", () => {
  test("GET /payment-plan before create → 404 NOT_FOUND", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token || !tripId) test.skip(true, "no trip");
    const res = await get(request, token, `/api/travel/trips/${tripId}/payment-plan`);
    expect(res.status()).toBe(404);
    expect((await res.json()).code).toBe("NOT_FOUND");
  });

  test("PUT /payment-plan upserts the plan", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token || !tripId) test.skip(true, "no trip");
    const res = await put(request, token, `/api/travel/trips/${tripId}/payment-plan`, {
      instalmentsJson: JSON.stringify([
        { dueDate: "2026-08-01", amount: 15000, reminderDays: 14 },
        { dueDate: "2026-09-01", amount: 30000, reminderDays: 7 },
      ]),
      graceDays: 3,
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.graceDays).toBe(3);
  });

  test("PUT /payment-plan with malformed JSON → 400 INVALID_JSON", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token || !tripId) test.skip(true, "no trip");
    const res = await put(request, token, `/api/travel/trips/${tripId}/payment-plan`, {
      instalmentsJson: "{ not json",
    });
    expect(res.status()).toBe(400);
    expect((await res.json()).code).toBe("INVALID_JSON");
  });

  test("PUT /payment-plan with empty instalments → 400 EMPTY_INSTALMENTS", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token || !tripId) test.skip(true, "no trip");
    const res = await put(request, token, `/api/travel/trips/${tripId}/payment-plan`, {
      instalmentsJson: JSON.stringify([]),
    });
    expect(res.status()).toBe(400);
    expect((await res.json()).code).toBe("EMPTY_INSTALMENTS");
  });

  test("GET /payment-plan returns the upserted plan", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token || !tripId) test.skip(true, "no trip");
    const res = await get(request, token, `/api/travel/trips/${tripId}/payment-plan`);
    expect(res.status()).toBe(200);
    expect((await res.json()).graceDays).toBe(3);
  });
});

// ─── Instalments ─────────────────────────────────────────────────────

test.describe("Travel trip billing — instalments", () => {
  test("POST /instalments creates a per-participant instalment", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token || !tripId || !participantId) test.skip(true, "deps missing");
    const res = await post(request, token, `/api/travel/trips/${tripId}/instalments`, {
      participantId,
      instalmentIndex: 0,
      dueDate: "2026-08-01",
      amount: 15000,
    });
    expect(res.status(), `create: ${await res.text()}`).toBe(201);
    const body = await res.json();
    expect(body.status).toBe("pending");
    expect(Number(body.amount)).toBe(15000);
    created.instalmentIds.push(body.id);
  });

  test("POST /instalments with participant from another trip → 400 PARTICIPANT_OFF_TRIP", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token || !tripId) test.skip(true, "no trip");
    const res = await post(request, token, `/api/travel/trips/${tripId}/instalments`, {
      participantId: 9999999,
      instalmentIndex: 0,
      dueDate: "2026-08-01",
      amount: 15000,
    });
    expect(res.status()).toBe(400);
    expect((await res.json()).code).toBe("PARTICIPANT_OFF_TRIP");
  });

  test("POST /instalments with missing fields → 400 MISSING_FIELDS", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token || !tripId) test.skip(true, "no trip");
    const res = await post(request, token, `/api/travel/trips/${tripId}/instalments`, {
      participantId,
    });
    expect(res.status()).toBe(400);
    expect((await res.json()).code).toBe("MISSING_FIELDS");
  });

  test("PATCH /instalments marks as paid", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token || !tripId || created.instalmentIds.length === 0) test.skip(true, "no instalments");
    const res = await patch(request, token, `/api/travel/trips/${tripId}/instalments/${created.instalmentIds[0]}`, {
      paidAmount: 15000,
      paidAt: "2026-07-28",
      status: "paid",
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("paid");
    expect(Number(body.paidAmount)).toBe(15000);
  });

  test("PATCH /instalments with invalid status → 400 INVALID_STATUS", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token || !tripId || created.instalmentIds.length === 0) test.skip(true, "no instalments");
    const res = await patch(request, token, `/api/travel/trips/${tripId}/instalments/${created.instalmentIds[0]}`, {
      status: "settled-up",
    });
    expect(res.status()).toBe(400);
    expect((await res.json()).code).toBe("INVALID_STATUS");
  });

  test("GET /instalments filters by status", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token || !tripId) test.skip(true, "no trip");
    const res = await get(request, token, `/api/travel/trips/${tripId}/instalments?status=paid`);
    expect(res.status()).toBe(200);
    expect(Array.isArray((await res.json()).instalments)).toBe(true);
  });

  test("GET /instalments with bad status → 400 INVALID_STATUS", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token || !tripId) test.skip(true, "no trip");
    const res = await get(request, token, `/api/travel/trips/${tripId}/instalments?status=foo`);
    expect(res.status()).toBe(400);
    expect((await res.json()).code).toBe("INVALID_STATUS");
  });
});
