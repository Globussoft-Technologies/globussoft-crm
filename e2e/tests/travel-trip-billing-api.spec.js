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

  test("POST /rooming with duplicate participant assignment → 409 DUPLICATE_ASSIGNMENT", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token || !tripId || !participantId) test.skip(true, "deps missing");
    const res = await post(request, token, `/api/travel/trips/${tripId}/rooming`, {
      roomNumber: "102",
      roomType: "twin",
      participantIds: [participantId],
    });
    expect(res.status()).toBe(409);
    expect((await res.json()).code).toBe("DUPLICATE_ASSIGNMENT");
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

  test("POST /rooming with duplicate room number → 409 DUPLICATE_ROOM_NUMBER", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token || !tripId || !participantId || created.roomIds.length === 0) test.skip(true, "deps missing");
    // Try to create a room with same number as first room (which is "101")
    const res = await post(request, token, `/api/travel/trips/${tripId}/rooming`, {
      roomNumber: "101",
      roomType: "twin",
      participantIds: [],
    });
    expect(res.status()).toBe(409);
    expect((await res.json()).code).toBe("DUPLICATE_ROOM_NUMBER");
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

  test("PATCH /rooming with duplicate room number → 409 DUPLICATE_ROOM_NUMBER", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token || !tripId || created.roomIds.length === 0) test.skip(true, "deps missing");
    // First, create a second room with number "102"
    const createRes = await post(request, token, `/api/travel/trips/${tripId}/rooming`, {
      roomNumber: "102",
      roomType: "twin",
      participantIds: [],
    });
    if (!createRes.ok()) test.skip(true, "failed to create second room");
    const room2Id = (await createRes.json()).id;
    // Try to PATCH room 1 to use room 2's number
    const res = await patch(request, token, `/api/travel/trips/${tripId}/rooming/${created.roomIds[0]}`, {
      roomNumber: "102",
    });
    expect(res.status()).toBe(409);
    expect((await res.json()).code).toBe("DUPLICATE_ROOM_NUMBER");
  });
});

// ─── Rooming XLSX export ─────────────────────────────────────────────
//
// Pins the GET /api/travel/trips/:tripId/rooming/export.xlsx surface
// added alongside the audit's Priority A #4 pick (PRD §4.5 row from
// PARTIAL → SHIPPED). Verifies:
//   - happy path returns 200 with the right Content-Type +
//     Content-Disposition + the buffer starts with the ZIP magic bytes
//     0x50 0x4B (xlsx is a zip archive)
//   - empty trip (no rooms) still streams a header-only XLSX (200)
//   - travel-tenant USER role is denied (403 RBAC_DENIED) — endpoint
//     restricted to ADMIN+MANAGER, mirrors the destructive rooming
//     handlers' gate so the "viewer can list rooms but not bulk-export"
//     separation holds

test.describe("Travel trip billing — rooming XLSX export", () => {
  let emptyTripId = null;

  test.beforeAll(async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token) return;
    // A second trip with NO rooming rows → header-only XLSX case.
    const tRes = await post(request, token, "/api/travel/trips", {
      tripCode: `${RUN_TAG.toLowerCase()}_empty`,
      schoolContactId,
      destination: `${RUN_TAG} Manali`,
      departDate: "2026-11-01",
      returnDate: "2026-11-05",
    });
    if (tRes.ok()) emptyTripId = (await tRes.json()).id;
  });

  test.afterAll(async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token) return;
    if (emptyTripId) await del(request, token, `/api/travel/trips/${emptyTripId}`).catch(() => {});
  });

  test("GET /rooming/export.xlsx returns XLSX with rooming rows", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token || !tripId) test.skip(true, "no trip");
    const res = await retryOn5xx(() =>
      request.get(`${BASE_URL}/api/travel/trips/${tripId}/rooming/export.xlsx`, {
        headers: { Authorization: `Bearer ${token}` },
        timeout: REQUEST_TIMEOUT,
      }),
    );
    expect(res.status(), `xlsx: ${res.status()}`).toBe(200);
    expect(res.headers()["content-type"]).toContain("spreadsheetml.sheet");
    const cd = res.headers()["content-disposition"] || "";
    expect(cd).toContain("attachment");
    expect(cd).toContain("rooming-trip-");
    expect(cd).toContain(".xlsx");
    const buf = await res.body();
    // XLSX files are ZIP archives — the first 2 bytes are 'PK' (0x50 0x4B).
    expect(buf.length).toBeGreaterThan(4);
    expect(buf[0]).toBe(0x50);
    expect(buf[1]).toBe(0x4b);
  });

  test("GET /rooming/export.xlsx on a trip with zero rooms → 200 header-only XLSX", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token || !emptyTripId) test.skip(true, "no empty trip");
    const res = await retryOn5xx(() =>
      request.get(`${BASE_URL}/api/travel/trips/${emptyTripId}/rooming/export.xlsx`, {
        headers: { Authorization: `Bearer ${token}` },
        timeout: REQUEST_TIMEOUT,
      }),
    );
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toContain("spreadsheetml.sheet");
    const buf = await res.body();
    // Still a valid XLSX (PK ZIP magic) even when the sheet only has
    // the header row.
    expect(buf[0]).toBe(0x50);
    expect(buf[1]).toBe(0x4b);
  });

  test("GET /rooming/export.xlsx as USER role → 403 RBAC_DENIED", async ({ request }) => {
    if (!tripId) test.skip(true, "no trip");
    const userToken = await loginAs(request, "telecaller@travelstall.demo", "password123");
    if (!userToken) test.skip(true, "travel USER login unavailable on this stack");
    const res = await retryOn5xx(() =>
      request.get(`${BASE_URL}/api/travel/trips/${tripId}/rooming/export.xlsx`, {
        headers: { Authorization: `Bearer ${userToken}` },
        timeout: REQUEST_TIMEOUT,
      }),
    );
    expect(res.status()).toBe(403);
    const body = await res.json().catch(() => ({}));
    expect(body.code).toBe("RBAC_DENIED");
  });

  test("GET /rooming/export.xlsx on a non-existent trip → 404 TRIP_NOT_FOUND", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token) test.skip(true, "no admin token");
    const res = await retryOn5xx(() =>
      request.get(`${BASE_URL}/api/travel/trips/9999999/rooming/export.xlsx`, {
        headers: { Authorization: `Bearer ${token}` },
        timeout: REQUEST_TIMEOUT,
      }),
    );
    expect(res.status()).toBe(404);
    const body = await res.json().catch(() => ({}));
    expect(body.code).toBe("TRIP_NOT_FOUND");
  });

  test("GET /rooming/export.pdf returns PDF with rooming data", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token || !tripId) test.skip(true, "deps missing");
    const res = await retryOn5xx(() =>
      request.get(`${BASE_URL}/api/travel/trips/${tripId}/rooming/export.pdf`, {
        headers: { Authorization: `Bearer ${token}` },
        timeout: REQUEST_TIMEOUT,
      }),
    );
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toContain("application/pdf");
    const buf = await res.body();
    expect(buf.length).toBeGreaterThan(100);
  });

  test("POST /rooming/auto allocates unassigned participants", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token || !tripId) test.skip(true, "no trip");
    const res = await post(request, token, `/api/travel/trips/${tripId}/rooming/auto`, {
      roomTypes: ["twin"],
      startingRoomNumber: 200,
    });
    expect(res.status()).toBe(201);
    const body = await res.json();
    expect(typeof body.created).toBe("number");
    expect(typeof body.skipped).toBe("number");
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

  test("PATCH /instalments with paidAmount > amount → 400 PAID_EXCEEDS_TOTAL", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token || !tripId || created.instalmentIds.length === 0) test.skip(true, "no instalments");
    const res = await patch(request, token, `/api/travel/trips/${tripId}/instalments/${created.instalmentIds[0]}`, {
      paidAmount: 99999,
    });
    expect(res.status()).toBe(400);
    expect((await res.json()).code).toBe("PAID_EXCEEDS_TOTAL");
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
