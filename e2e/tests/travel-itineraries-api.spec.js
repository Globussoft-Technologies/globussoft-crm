// @ts-check
/**
 * Gate spec — travel-vertical itinerary CRUD.
 *
 * Pins the Day 6 commit. Covers:
 *   GET    /api/travel/itineraries
 *   POST   /api/travel/itineraries
 *   GET    /api/travel/itineraries/:id
 *   PATCH  /api/travel/itineraries/:id
 *   DELETE /api/travel/itineraries/:id              (ADMIN only)
 *   POST   /api/travel/itineraries/:id/items
 *   PATCH  /api/travel/itineraries/:id/items/:itemId
 *   DELETE /api/travel/itineraries/:id/items/:itemId
 *
 * Plus the cross-vertical guard (rejects generic + wellness tenants
 * with 403 WRONG_VERTICAL).
 *
 * Auth deps: yasin@travelstall.in (travel ADMIN, seeded by
 * seed-travel.js) + admin@globussoft.com (generic ADMIN, in seed.js).
 *
 * Contact dep: the spec needs a contactId for itinerary creation.
 * Travel Stall's tenant doesn't ship with seeded Contacts in Day 1,
 * so we create one in beforeAll + clean up in afterAll.
 */

const { test, expect } = require("@playwright/test");

test.describe.configure({ mode: "serial" });

const BASE_URL = process.env.BASE_URL || "https://crm.globusdemos.com";
const REQUEST_TIMEOUT = 60000;
const RUN_TAG = `E2E_TRAVEL_ITIN_${Date.now()}`;

let travelAdminToken = null;
let genericAdminToken = null;
let testContactId = null;

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
  return retryOn5xx(() =>
    request.post(`${BASE_URL}${path}`, { headers: headers(token), data: body ?? {}, timeout: REQUEST_TIMEOUT }),
  );
}
async function patch(request, token, path, body) {
  return retryOn5xx(() =>
    request.patch(`${BASE_URL}${path}`, { headers: headers(token), data: body ?? {}, timeout: REQUEST_TIMEOUT }),
  );
}
async function del(request, token, path) {
  return retryOn5xx(() =>
    request.delete(`${BASE_URL}${path}`, { headers: headers(token), timeout: REQUEST_TIMEOUT }),
  );
}

// Tracking for cleanup
const created = { itineraryIds: [], itemIds: [] };

test.beforeAll(async ({ request }) => {
  const token = await getTravelAdmin(request);
  if (!token) return;
  // Spec needs a Contact owned by the travel tenant. Create one — tagged
  // with the RUN_TAG so demo-scrub can sweep it.
  const r = await post(request, token, "/api/contacts", {
    name: `${RUN_TAG} Itinerary Test Contact`,
    email: `${RUN_TAG.toLowerCase()}@e2e.test`,
    phone: `+91${String(Date.now()).slice(-10)}`,
    subBrand: "rfu",
  });
  if (r.ok()) {
    const body = await r.json();
    testContactId = body.id || body.contact?.id;
  }
  if (!testContactId) return;

  // PRD §4.1 diagnostic-first guard: POST /itineraries now refuses to
  // create a quote for a contact without a prior diagnostic for the
  // subBrand. Submit one against the seeded RFU bank v1 so the
  // happy-path tests can create itineraries. The bank lookup tolerates
  // any active v1 RFU bank (seed-travel.js seeds one).
  const banksRes = await get(request, token, "/api/travel/diagnostic-banks?subBrand=rfu&active=true");
  if (banksRes.ok()) {
    const banks = (await banksRes.json()).banks || [];
    const rfuBank = banks.find((b) => b.subBrand === "rfu");
    if (rfuBank) {
      await post(request, token, "/api/travel/diagnostics", {
        bankId: rfuBank.id,
        answers: { q1: "few", q2: "medium" },
        contactId: testContactId,
      }).catch(() => null);
    }
  }
});

test.afterAll(async ({ request }) => {
  const token = await getTravelAdmin(request);
  if (!token) return;
  const deadline = Date.now() + 40_000;
  // Itineraries cascade-delete their items.
  for (const id of created.itineraryIds) {
    if (Date.now() > deadline) break;
    await del(request, token, `/api/travel/itineraries/${id}`).catch(() => {});
  }
  if (testContactId) {
    await del(request, token, `/api/contacts/${testContactId}`).catch(() => {});
  }
});

// ─── Vertical guard ──────────────────────────────────────────────────

test.describe("Travel itineraries API — vertical guard", () => {
  test("GET /itineraries rejects generic-vertical caller with 403 WRONG_VERTICAL", async ({ request }) => {
    const token = await getGenericAdmin(request);
    if (!token) test.skip(true, "admin@globussoft.com not seeded");
    const res = await get(request, token, "/api/travel/itineraries");
    expect(res.status()).toBe(403);
    expect((await res.json()).code).toBe("WRONG_VERTICAL");
  });

  test("GET /itineraries without auth → 401/403", async ({ request }) => {
    const res = await request.get(`${BASE_URL}/api/travel/itineraries`, { timeout: REQUEST_TIMEOUT });
    expect([401, 403]).toContain(res.status());
  });

  test("POST /itineraries without auth → 401/403", async ({ request }) => {
    const res = await request.post(`${BASE_URL}/api/travel/itineraries`, {
      data: { subBrand: "rfu", contactId: 1, destination: "Mecca" },
      headers: { "Content-Type": "application/json" },
      timeout: REQUEST_TIMEOUT,
    });
    expect([401, 403]).toContain(res.status());
  });
});

// ─── Create + list ───────────────────────────────────────────────────

test.describe("Travel itineraries API — create + list", () => {
  test("POST /itineraries creates a draft itinerary", async ({ request }) => {
    const token = await getTravelAdmin(request);
    expect(token, "yasin@travelstall.in must be seeded").toBeTruthy();
    expect(testContactId, "test contact must be created in beforeAll").toBeTruthy();

    const res = await post(request, token, "/api/travel/itineraries", {
      subBrand: "rfu",
      contactId: testContactId,
      destination: `${RUN_TAG} Umrah package`,
      startDate: "2026-06-15",
      endDate: "2026-06-25",
      totalAmount: 175000.5,
      currency: "INR",
    });
    expect(res.status(), `create: ${await res.text()}`).toBe(201);
    const body = await res.json();
    expect(body.id).toBeTruthy();
    expect(body.status).toBe("draft");
    expect(body.subBrand).toBe("rfu");
    expect(Number(body.totalAmount)).toBe(175000.5);
    expect(Array.isArray(body.items)).toBe(true);
    expect(body.items).toHaveLength(0);
    created.itineraryIds.push(body.id);
  });

  test("POST /itineraries with embedded items creates them in one shot", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token || !testContactId) test.skip(true, "test contact missing");
    const res = await post(request, token, "/api/travel/itineraries", {
      subBrand: "rfu",
      contactId: testContactId,
      destination: `${RUN_TAG} Multi-item package`,
      items: [
        { itemType: "flight", description: "BLR-JED economy", unitCost: 35000 },
        { itemType: "hotel", description: "Haram view 7n", unitCost: 90000 },
        { itemType: "transfer", description: "Airport pickup", unitCost: 3000 },
      ],
    });
    expect(res.status()).toBe(201);
    const body = await res.json();
    expect(body.items).toHaveLength(3);
    expect(body.items[0].itemType).toBe("flight");
    expect(body.items[1].itemType).toBe("hotel");
    // Auto-position is by array order
    expect(body.items.map((i) => i.position)).toEqual([0, 1, 2]);
    created.itineraryIds.push(body.id);
  });

  test("POST /itineraries with missing fields → 400 MISSING_FIELDS", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token) test.skip(true, "travel admin not available");
    const res = await post(request, token, "/api/travel/itineraries", {
      subBrand: "rfu",
      // contactId + destination missing
    });
    expect(res.status()).toBe(400);
    expect((await res.json()).code).toBe("MISSING_FIELDS");
  });

  test("POST /itineraries with bad subBrand → 400 INVALID_SUB_BRAND", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token || !testContactId) test.skip(true, "deps missing");
    const res = await post(request, token, "/api/travel/itineraries", {
      subBrand: "made-up",
      contactId: testContactId,
      destination: "x",
    });
    expect(res.status()).toBe(400);
    expect((await res.json()).code).toBe("INVALID_SUB_BRAND");
  });

  test("POST /itineraries with bad item type → 400 INVALID_ITEM_TYPE", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token || !testContactId) test.skip(true, "deps missing");
    const res = await post(request, token, "/api/travel/itineraries", {
      subBrand: "rfu",
      contactId: testContactId,
      destination: "x",
      items: [{ itemType: "submarine", description: "x" }],
    });
    expect(res.status()).toBe(400);
    expect((await res.json()).code).toBe("INVALID_ITEM_TYPE");
  });

  test("GET /itineraries?subBrand=rfu returns the created itineraries", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token || created.itineraryIds.length === 0) test.skip(true, "no itineraries");
    const res = await get(request, token, "/api/travel/itineraries?subBrand=rfu");
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.itineraries)).toBe(true);
    expect(body.itineraries.length).toBeGreaterThanOrEqual(created.itineraryIds.length);
    expect(body.total).toBeGreaterThanOrEqual(created.itineraryIds.length);
  });

  test("GET /itineraries?status=invalid → 400 INVALID_STATUS", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token) test.skip(true, "travel admin not available");
    const res = await get(request, token, "/api/travel/itineraries?status=foobar");
    expect(res.status()).toBe(400);
    expect((await res.json()).code).toBe("INVALID_STATUS");
  });
});

// ─── PRD §4.1 diagnostic-first guard ────────────────────────────────

test.describe("Travel itineraries API — diagnostic-first guard (PRD §4.1)", () => {
  let noDiagnosticContactId = null;

  test.beforeAll(async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token) return;
    // Contact created here intentionally does NOT submit a diagnostic.
    // The guard test below asserts the itinerary endpoint refuses on its
    // behalf. Same RUN_TAG so demo-scrub cleans it.
    const r = await post(request, token, "/api/contacts", {
      name: `${RUN_TAG} No-Diagnostic Contact`,
      email: `${RUN_TAG.toLowerCase()}-nodiag@e2e.test`,
      phone: `+91${String(Date.now() + 1).slice(-10)}`,
      subBrand: "rfu",
    });
    if (r.ok()) {
      const body = await r.json();
      noDiagnosticContactId = body.id || body.contact?.id;
    }
  });

  test.afterAll(async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token || !noDiagnosticContactId) return;
    await del(request, token, `/api/contacts/${noDiagnosticContactId}`).catch(() => {});
  });

  test("POST /itineraries for a contact without a diagnostic → 403 DIAGNOSTIC_REQUIRED", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token || !noDiagnosticContactId) test.skip(true, "deps missing");
    const res = await post(request, token, "/api/travel/itineraries", {
      subBrand: "rfu",
      contactId: noDiagnosticContactId,
      destination: `${RUN_TAG} should-be-rejected`,
    });
    expect(res.status(), `body: ${await res.text()}`).toBe(403);
    const body = await res.json();
    expect(body.code).toBe("DIAGNOSTIC_REQUIRED");
  });

  test("POST /itineraries for a contact WITH a diagnostic → 201 (guard passes)", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token || !testContactId) test.skip(true, "testContactId missing — beforeAll diagnostic submission likely failed");
    // testContactId already had a diagnostic submitted in the outer beforeAll.
    const res = await post(request, token, "/api/travel/itineraries", {
      subBrand: "rfu",
      contactId: testContactId,
      destination: `${RUN_TAG} guard-passes`,
    });
    expect(res.status(), `body: ${await res.text()}`).toBe(201);
    const body = await res.json();
    created.itineraryIds.push(body.id);
  });
});

// ─── Get + amend ─────────────────────────────────────────────────────

test.describe("Travel itineraries API — get + amend", () => {
  test("GET /itineraries/:id returns the itinerary with items", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token || created.itineraryIds.length < 2) test.skip(true, "need 2nd itinerary");
    const id = created.itineraryIds[1]; // the 3-item one
    const res = await get(request, token, `/api/travel/itineraries/${id}`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.id).toBe(id);
    expect(body.items).toHaveLength(3);
  });

  test("GET /itineraries/:id unknown → 404 NOT_FOUND", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token) test.skip(true, "travel admin not available");
    const res = await get(request, token, "/api/travel/itineraries/9999999");
    expect(res.status()).toBe(404);
    expect((await res.json()).code).toBe("NOT_FOUND");
  });

  test("PATCH /itineraries/:id amends status + totalAmount", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token || created.itineraryIds.length === 0) test.skip(true, "no itineraries");
    const id = created.itineraryIds[0];
    const res = await patch(request, token, `/api/travel/itineraries/${id}`, {
      status: "sent",
      totalAmount: 200000,
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("sent");
    expect(Number(body.totalAmount)).toBe(200000);
  });

  test("PATCH /itineraries/:id with invalid status → 400 INVALID_STATUS", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token || created.itineraryIds.length === 0) test.skip(true, "no itineraries");
    const res = await patch(request, token, `/api/travel/itineraries/${created.itineraryIds[0]}`, {
      status: "uncertain",
    });
    expect(res.status()).toBe(400);
    expect((await res.json()).code).toBe("INVALID_STATUS");
  });

  test("PATCH /itineraries/:id with empty body → 400 EMPTY_BODY", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token || created.itineraryIds.length === 0) test.skip(true, "no itineraries");
    const res = await patch(request, token, `/api/travel/itineraries/${created.itineraryIds[0]}`, {});
    expect(res.status()).toBe(400);
    expect((await res.json()).code).toBe("EMPTY_BODY");
  });
});

// ─── Item endpoints ──────────────────────────────────────────────────

test.describe("Travel itineraries API — items", () => {
  test("POST /:id/items appends a new polymorphic item", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token || created.itineraryIds.length === 0) test.skip(true, "no itineraries");
    const id = created.itineraryIds[0];
    const res = await post(request, token, `/api/travel/itineraries/${id}/items`, {
      itemType: "activity",
      description: `${RUN_TAG} city tour`,
      totalPrice: 1500,
    });
    expect(res.status()).toBe(201);
    const body = await res.json();
    expect(body.itemType).toBe("activity");
    expect(body.position).toBeGreaterThanOrEqual(0);
    created.itemIds.push(body.id);
  });

  test("POST /:id/items with bad type → 400 INVALID_ITEM_TYPE", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token || created.itineraryIds.length === 0) test.skip(true, "no itineraries");
    const res = await post(
      request,
      token,
      `/api/travel/itineraries/${created.itineraryIds[0]}/items`,
      { itemType: "submarine", description: "x" },
    );
    expect(res.status()).toBe(400);
    expect((await res.json()).code).toBe("INVALID_ITEM_TYPE");
  });

  test("PATCH /:id/items/:itemId amends a field", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token || created.itemIds.length === 0) test.skip(true, "no items");
    const itinId = created.itineraryIds[0];
    const itemId = created.itemIds[0];
    const res = await patch(
      request,
      token,
      `/api/travel/itineraries/${itinId}/items/${itemId}`,
      { description: `${RUN_TAG} amended desc`, totalPrice: 2000 },
    );
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.description).toContain("amended desc");
    expect(Number(body.totalPrice)).toBe(2000);
  });

  test("DELETE /:id/items/:itemId removes the item", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token || created.itemIds.length === 0) test.skip(true, "no items");
    const itinId = created.itineraryIds[0];
    const itemId = created.itemIds[0];
    const res = await del(request, token, `/api/travel/itineraries/${itinId}/items/${itemId}`);
    expect(res.status()).toBe(200);
    expect((await res.json()).deleted).toBe(true);
    // Verify it's gone from the itinerary's items list
    const after = await get(request, token, `/api/travel/itineraries/${itinId}`);
    const ids = (await after.json()).items.map((i) => i.id);
    expect(ids).not.toContain(itemId);
  });

  test("DELETE /:id/items/:itemId unknown item → 404 ITEM_NOT_FOUND", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token || created.itineraryIds.length === 0) test.skip(true, "no itineraries");
    const res = await del(
      request,
      token,
      `/api/travel/itineraries/${created.itineraryIds[0]}/items/9999999`,
    );
    expect(res.status()).toBe(404);
    expect((await res.json()).code).toBe("ITEM_NOT_FOUND");
  });
});

// ─── Version chain + accept/reject + share (PRD §4.3 / §6.1) ────────

async function putReq(request, token, path, body) {
  return retryOn5xx(() =>
    request.put(`${BASE_URL}${path}`, {
      headers: headers(token), data: body ?? {}, timeout: REQUEST_TIMEOUT,
    }),
  );
}

test.describe("Travel itineraries API — version chain + status transitions", () => {
  let baseItineraryId = null;

  test.beforeAll(async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token || !testContactId) return;
    const res = await post(request, token, "/api/travel/itineraries", {
      subBrand: "rfu",
      contactId: testContactId,
      destination: `${RUN_TAG} version-chain root`,
      totalAmount: 50000,
      currency: "INR",
    });
    if (res.ok()) {
      baseItineraryId = (await res.json()).id;
      created.itineraryIds.push(baseItineraryId);
    }
  });

  test("PUT /itineraries/:id creates a new revised version linked via parentItineraryId", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token || !baseItineraryId) test.skip(true, "base itinerary missing");
    const res = await putReq(request, token, `/api/travel/itineraries/${baseItineraryId}`, {
      destination: `${RUN_TAG} v2 destination`,
      totalAmount: 60000,
    });
    expect(res.status(), `put: ${await res.text()}`).toBe(201);
    const body = await res.json();
    expect(body.id).not.toBe(baseItineraryId);
    expect(body.version).toBeGreaterThanOrEqual(2);
    expect(body.parentItineraryId).toBe(baseItineraryId);
    expect(body.status).toBe("revised");
    expect(Number(body.totalAmount)).toBe(60000);
    created.itineraryIds.push(body.id);
  });

  test("PUT /itineraries/:id second revision: version increments to 3", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token || !baseItineraryId) test.skip(true, "base itinerary missing");
    const res = await putReq(request, token, `/api/travel/itineraries/${baseItineraryId}`, {
      destination: `${RUN_TAG} v3 destination`,
    });
    expect(res.status()).toBe(201);
    const body = await res.json();
    expect(body.version).toBeGreaterThanOrEqual(3);
    expect(body.parentItineraryId).toBe(baseItineraryId);
    created.itineraryIds.push(body.id);
  });

  test("POST /itineraries/:id/accept flips status to 'accepted'", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token || !testContactId) test.skip(true, "deps missing");
    // Create a fresh itinerary so we don't disturb the version-chain head.
    const created1 = await post(request, token, "/api/travel/itineraries", {
      subBrand: "rfu", contactId: testContactId, destination: `${RUN_TAG} accept-target`,
    });
    expect(created1.status()).toBe(201);
    const id = (await created1.json()).id;
    created.itineraryIds.push(id);

    const res = await post(request, token, `/api/travel/itineraries/${id}/accept`);
    expect(res.status()).toBe(200);
    expect((await res.json()).status).toBe("accepted");
  });

  test("POST /itineraries/:id/accept twice → 409 ALREADY_ACCEPTED", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token || !testContactId) test.skip(true, "deps missing");
    const created1 = await post(request, token, "/api/travel/itineraries", {
      subBrand: "rfu", contactId: testContactId, destination: `${RUN_TAG} accept-dup`,
    });
    const id = (await created1.json()).id;
    created.itineraryIds.push(id);
    await post(request, token, `/api/travel/itineraries/${id}/accept`);
    const res = await post(request, token, `/api/travel/itineraries/${id}/accept`);
    expect(res.status()).toBe(409);
    expect((await res.json()).code).toBe("ALREADY_ACCEPTED");
  });

  test("POST /itineraries/:id/reject flips status to 'rejected'; reason logged", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token || !testContactId) test.skip(true, "deps missing");
    const created1 = await post(request, token, "/api/travel/itineraries", {
      subBrand: "rfu", contactId: testContactId, destination: `${RUN_TAG} reject-target`,
    });
    const id = (await created1.json()).id;
    created.itineraryIds.push(id);

    const res = await post(request, token, `/api/travel/itineraries/${id}/reject`, {
      reason: "Customer found a cheaper option",
    });
    expect(res.status()).toBe(200);
    expect((await res.json()).status).toBe("rejected");
  });

  test("POST /itineraries/:id/accept on rejected → 409 ALREADY_REJECTED", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token || !testContactId) test.skip(true, "deps missing");
    const created1 = await post(request, token, "/api/travel/itineraries", {
      subBrand: "rfu", contactId: testContactId, destination: `${RUN_TAG} reject-then-accept`,
    });
    const id = (await created1.json()).id;
    created.itineraryIds.push(id);
    await post(request, token, `/api/travel/itineraries/${id}/reject`);
    const res = await post(request, token, `/api/travel/itineraries/${id}/accept`);
    expect(res.status()).toBe(409);
    expect((await res.json()).code).toBe("ALREADY_REJECTED");
  });

  test("POST /itineraries/:id/share mints a shareToken + URL, idempotent on re-call", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token || !testContactId) test.skip(true, "deps missing");
    const created1 = await post(request, token, "/api/travel/itineraries", {
      subBrand: "rfu", contactId: testContactId, destination: `${RUN_TAG} share-target`,
    });
    const id = (await created1.json()).id;
    created.itineraryIds.push(id);

    const first = await post(request, token, `/api/travel/itineraries/${id}/share`);
    expect(first.status()).toBe(200);
    const firstBody = await first.json();
    expect(firstBody.shareToken).toBeTruthy();
    expect(firstBody.shareUrl).toContain(firstBody.shareToken);

    // Re-calling returns the SAME token (so existing WhatsApp links don't break).
    const second = await post(request, token, `/api/travel/itineraries/${id}/share`);
    expect(second.status()).toBe(200);
    expect((await second.json()).shareToken).toBe(firstBody.shareToken);
  });
});
