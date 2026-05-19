// @ts-check
/**
 * Gate spec — TMC trip CRUD + participants + document requirements.
 *
 * Pins the Day 7 commit. Covers:
 *   GET    /api/travel/trips
 *   POST   /api/travel/trips
 *   GET    /api/travel/trips/:id
 *   PATCH  /api/travel/trips/:id
 *   DELETE /api/travel/trips/:id           (ADMIN only)
 *   GET    /api/travel/trips/:id/participants
 *   POST   /api/travel/trips/:id/participants
 *   PATCH  /api/travel/trips/:id/participants/:pid
 *   DELETE /api/travel/trips/:id/participants/:pid
 *   GET    /api/travel/trips/:id/documents
 *   POST   /api/travel/trips/:id/documents
 *   DELETE /api/travel/trips/:id/documents/:docId
 *
 * Plus the Aadhaar-safety guard: rejects aadhaarLast4 values that
 * aren't exactly 4 digits (per Aadhaar Act §29 + R8 in the risk
 * register — a 12-digit submission would be a privacy incident).
 */

const { test, expect } = require("@playwright/test");

test.describe.configure({ mode: "serial" });

const BASE_URL = process.env.BASE_URL || "https://crm.globusdemos.com";
const REQUEST_TIMEOUT = 60000;
const RUN_TAG = `E2E_TRAVEL_TRIP_${Date.now()}`;

let travelAdminToken = null;
let genericAdminToken = null;
let schoolContactId = null;

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
async function patch(request, token, path, body) {
  return retryOn5xx(() => request.patch(`${BASE_URL}${path}`, { headers: headers(token), data: body ?? {}, timeout: REQUEST_TIMEOUT }));
}
async function del(request, token, path) {
  return retryOn5xx(() => request.delete(`${BASE_URL}${path}`, { headers: headers(token), timeout: REQUEST_TIMEOUT }));
}

const created = { tripIds: [], participantIds: [], docIds: [] };
const tripCode = `${RUN_TAG.toLowerCase()}_v1`;

test.beforeAll(async ({ request }) => {
  const token = await getTravelAdmin(request);
  if (!token) return;
  // Need a school Contact to attach the trip to.
  const r = await post(request, token, "/api/contacts", {
    name: `${RUN_TAG} Bharat International School`,
    email: `${RUN_TAG.toLowerCase()}-school@e2e.test`,
    phone: `+91${String(Date.now()).slice(-10)}`,
    subBrand: "tmc",
  });
  if (r.ok()) {
    const body = await r.json();
    schoolContactId = body.id || body.contact?.id;
  }
});

test.afterAll(async ({ request }) => {
  const token = await getTravelAdmin(request);
  if (!token) return;
  const deadline = Date.now() + 40_000;
  for (const id of created.tripIds) {
    if (Date.now() > deadline) break;
    await del(request, token, `/api/travel/trips/${id}`).catch(() => {});
  }
  if (schoolContactId) {
    await del(request, token, `/api/contacts/${schoolContactId}`).catch(() => {});
  }
});

// ─── Vertical guard + auth ───────────────────────────────────────────

test.describe("Travel trips API — guards", () => {
  test("GET /trips rejects generic admin with 403 WRONG_VERTICAL", async ({ request }) => {
    const token = await getGenericAdmin(request);
    if (!token) test.skip(true, "admin@globussoft.com not seeded");
    const res = await get(request, token, "/api/travel/trips");
    expect(res.status()).toBe(403);
    expect((await res.json()).code).toBe("WRONG_VERTICAL");
  });

  test("GET /trips without auth → 401/403", async ({ request }) => {
    const res = await request.get(`${BASE_URL}/api/travel/trips`, { timeout: REQUEST_TIMEOUT });
    expect([401, 403]).toContain(res.status());
  });
});

// ─── Trip CRUD ───────────────────────────────────────────────────────

test.describe("Travel trips API — trip CRUD", () => {
  test("POST /trips creates a TMC trip", async ({ request }) => {
    const token = await getTravelAdmin(request);
    expect(token, "yasin@travelstall.in must be seeded").toBeTruthy();
    expect(schoolContactId, "school contact must be created").toBeTruthy();

    const res = await post(request, token, "/api/travel/trips", {
      tripCode,
      schoolContactId,
      destination: `${RUN_TAG} Bali Educational Tour`,
      departDate: "2026-08-15",
      returnDate: "2026-08-25",
      pricePerStudent: 45000,
    });
    expect(res.status(), `create: ${await res.text()}`).toBe(201);
    const body = await res.json();
    expect(body.tripCode).toBe(tripCode);
    expect(body.status).toBe("confirmed");
    expect(body.legalEntity).toBe("tmc_nexus");
    expect(Number(body.pricePerStudent)).toBe(45000);
    created.tripIds.push(body.id);
  });

  test("POST /trips with duplicate tripCode → 409 DUPLICATE_TRIP_CODE", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token || !schoolContactId) test.skip(true, "deps missing");
    const res = await post(request, token, "/api/travel/trips", {
      tripCode, // same code
      schoolContactId,
      destination: "x",
      departDate: "2026-08-15",
      returnDate: "2026-08-25",
    });
    expect(res.status()).toBe(409);
    expect((await res.json()).code).toBe("DUPLICATE_TRIP_CODE");
  });

  test("POST /trips with missing fields → 400 MISSING_FIELDS", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token) test.skip(true, "no token");
    const res = await post(request, token, "/api/travel/trips", { tripCode: `${RUN_TAG}_x` });
    expect(res.status()).toBe(400);
    expect((await res.json()).code).toBe("MISSING_FIELDS");
  });

  test("POST /trips with returnDate < departDate → 400 INVERTED_DATES", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token || !schoolContactId) test.skip(true, "deps missing");
    const res = await post(request, token, "/api/travel/trips", {
      tripCode: `${RUN_TAG}_inverted`,
      schoolContactId,
      destination: "x",
      departDate: "2026-09-10",
      returnDate: "2026-09-01",
    });
    expect(res.status()).toBe(400);
    expect((await res.json()).code).toBe("INVERTED_DATES");
  });

  test("GET /trips lists trips", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token || created.tripIds.length === 0) test.skip(true, "no trips");
    const res = await get(request, token, "/api/travel/trips");
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.trips)).toBe(true);
    expect(body.trips.length).toBeGreaterThanOrEqual(1);
  });

  test("GET /trips/:id returns trip with children", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token || created.tripIds.length === 0) test.skip(true, "no trips");
    const res = await get(request, token, `/api/travel/trips/${created.tripIds[0]}`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.id).toBe(created.tripIds[0]);
    expect(Array.isArray(body.participants)).toBe(true);
    expect(Array.isArray(body.documentRequirements)).toBe(true);
  });

  test("PATCH /trips/:id amends status + price", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token || created.tripIds.length === 0) test.skip(true, "no trips");
    const res = await patch(request, token, `/api/travel/trips/${created.tripIds[0]}`, {
      status: "in-trip",
      pricePerStudent: 47500,
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("in-trip");
    expect(Number(body.pricePerStudent)).toBe(47500);
  });

  test("PATCH /trips/:id with invalid status → 400 INVALID_STATUS", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token || created.tripIds.length === 0) test.skip(true, "no trips");
    const res = await patch(request, token, `/api/travel/trips/${created.tripIds[0]}`, {
      status: "vacationing",
    });
    expect(res.status()).toBe(400);
    expect((await res.json()).code).toBe("INVALID_STATUS");
  });
});

// ─── Participants ────────────────────────────────────────────────────

test.describe("Travel trips API — participants", () => {
  test("POST /trips/:id/participants adds a participant", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token || created.tripIds.length === 0) test.skip(true, "no trips");
    const res = await post(request, token, `/api/travel/trips/${created.tripIds[0]}/participants`, {
      fullName: `${RUN_TAG} Aarav Kumar`,
      parentName: "Mrs. Kumar",
      parentPhone: "+919876500001",
      passportNumber: "K9876543",
    });
    expect(res.status()).toBe(201);
    const body = await res.json();
    expect(body.fullName).toContain("Aarav");
    created.participantIds.push(body.id);
  });

  test("POST participant with missing fullName → 400 MISSING_FIELDS", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token || created.tripIds.length === 0) test.skip(true, "no trips");
    const res = await post(request, token, `/api/travel/trips/${created.tripIds[0]}/participants`, {
      parentName: "no kid",
    });
    expect(res.status()).toBe(400);
    expect((await res.json()).code).toBe("MISSING_FIELDS");
  });

  test("POST participant with full 12-digit Aadhaar → 400 INVALID_AADHAAR_LAST4 (Aadhaar Act §29 guard)", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token || created.tripIds.length === 0) test.skip(true, "no trips");
    const res = await post(request, token, `/api/travel/trips/${created.tripIds[0]}/participants`, {
      fullName: "Privacy Probe",
      aadhaarLast4: "123456789012", // 12 digits — must be rejected
    });
    expect(res.status()).toBe(400);
    expect((await res.json()).code).toBe("INVALID_AADHAAR_LAST4");
  });

  test("POST participant with valid 4-digit aadhaarLast4 succeeds", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token || created.tripIds.length === 0) test.skip(true, "no trips");
    const res = await post(request, token, `/api/travel/trips/${created.tripIds[0]}/participants`, {
      fullName: `${RUN_TAG} Priya Sharma`,
      aadhaarLast4: "5678",
    });
    expect(res.status()).toBe(201);
    const body = await res.json();
    expect(body.aadhaarLast4).toBe("5678");
    created.participantIds.push(body.id);
  });

  test("GET /trips/:id/participants lists them", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token || created.tripIds.length === 0) test.skip(true, "no trips");
    const res = await get(request, token, `/api/travel/trips/${created.tripIds[0]}/participants`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.participants)).toBe(true);
    expect(body.participants.length).toBeGreaterThanOrEqual(2);
  });

  test("PATCH participant amends parentPhone", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token || created.participantIds.length === 0) test.skip(true, "no participants");
    const tripId = created.tripIds[0];
    const pid = created.participantIds[0];
    const res = await patch(request, token, `/api/travel/trips/${tripId}/participants/${pid}`, {
      parentPhone: "+919876512345",
    });
    expect(res.status()).toBe(200);
    expect((await res.json()).parentPhone).toBe("+919876512345");
  });

  test("DELETE participant removes it", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token || created.participantIds.length < 2) test.skip(true, "need 2 participants");
    const tripId = created.tripIds[0];
    const pid = created.participantIds[1];
    const res = await del(request, token, `/api/travel/trips/${tripId}/participants/${pid}`);
    expect(res.status()).toBe(200);
    expect((await res.json()).deleted).toBe(true);
  });
});

// ─── Documents ───────────────────────────────────────────────────────

test.describe("Travel trips API — document requirements", () => {
  test("POST /trips/:id/documents adds a required doc", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token || created.tripIds.length === 0) test.skip(true, "no trips");
    const res = await post(request, token, `/api/travel/trips/${created.tripIds[0]}/documents`, {
      docType: "passport",
    });
    expect(res.status()).toBe(201);
    const body = await res.json();
    expect(body.docType).toBe("passport");
    expect(body.required).toBe(true);
    created.docIds.push(body.id);
  });

  test("GET /trips/:id/documents lists them", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token || created.tripIds.length === 0) test.skip(true, "no trips");
    const res = await get(request, token, `/api/travel/trips/${created.tripIds[0]}/documents`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.documents)).toBe(true);
    expect(body.documents.length).toBeGreaterThanOrEqual(1);
  });

  test("DELETE doc requirement removes it", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token || created.docIds.length === 0) test.skip(true, "no docs");
    const tripId = created.tripIds[0];
    const docId = created.docIds[0];
    const res = await del(request, token, `/api/travel/trips/${tripId}/documents/${docId}`);
    expect(res.status()).toBe(200);
    expect((await res.json()).deleted).toBe(true);
  });
});
