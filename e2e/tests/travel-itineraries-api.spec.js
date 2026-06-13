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

// ─── PRD §6.4 productTier capture-from-latest-diagnostic ─────────────

test.describe("Travel itineraries API — productTier defaulting (PRD §6.4)", () => {
  test("POST /itineraries with no productTier defaults from the latest diagnostic", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token || !testContactId) test.skip(true, "deps missing");
    const res = await post(request, token, "/api/travel/itineraries", {
      subBrand: "rfu",
      contactId: testContactId,
      destination: `${RUN_TAG} tier-defaulted`,
    });
    expect(res.status(), `body: ${await res.text()}`).toBe(201);
    const body = await res.json();
    // The diagnostic submitted in the outer beforeAll (answers q1=few +
    // q2=medium) classifies into one of these three tiers under the
    // seeded RFU bank's scoring rules.
    expect(["entry", "primary", "premium"]).toContain(body.productTier);
    created.itineraryIds.push(body.id);
  });

  test("POST /itineraries with explicit productTier honours the override", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token || !testContactId) test.skip(true, "deps missing");
    const res = await post(request, token, "/api/travel/itineraries", {
      subBrand: "rfu",
      contactId: testContactId,
      destination: `${RUN_TAG} tier-overridden`,
      productTier: "premium",
    });
    expect(res.status()).toBe(201);
    const body = await res.json();
    expect(body.productTier).toBe("premium");
    created.itineraryIds.push(body.id);
  });

  test("GET /itineraries/:id round-trips productTier", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token || created.itineraryIds.length === 0) test.skip(true, "need a created itinerary");
    // The most-recently-pushed id is the explicit-override case above, so
    // we know exactly what to expect on the read.
    const id = created.itineraryIds[created.itineraryIds.length - 1];
    const res = await get(request, token, `/api/travel/itineraries/${id}`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.productTier).toBe("premium");
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
    // The route never trusts a client-supplied totalPrice — it recomputes the
    // line total from price-affecting fields (computeItemLineTotal:
    // unitCost*quantity + markup + gstAmount). So drive the total via those
    // fields: 2000*1 + 0 + 0 = 2000.
    const res = await patch(
      request,
      token,
      `/api/travel/itineraries/${itinId}/items/${itemId}`,
      { description: `${RUN_TAG} amended desc`, unitCost: 2000, quantity: 1, markup: 0, gstAmount: 0 },
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

  // S118 — POST /items must accept latitude + longitude (was silently
  // dropping them pre-S118; S82's frontend geocode-on-create flow then
  // had to round-trip via PATCH to actually persist coords). Mirrors
  // the PATCH validation (lat ∈ [-90, 90], lng ∈ [-180, 180]).
  test("POST /:id/items with lat/lng → coords round-trip via GET (S118)", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token || created.itineraryIds.length === 0) test.skip(true, "no itineraries");
    const id = created.itineraryIds[0];
    const res = await post(request, token, `/api/travel/itineraries/${id}/items`, {
      itemType: "activity",
      description: `${RUN_TAG} geo activity`,
      latitude: 15.2993,
      longitude: 74.124,
    });
    expect(res.status()).toBe(201);
    const body = await res.json();
    expect(Number(body.latitude)).toBeCloseTo(15.2993, 4);
    expect(Number(body.longitude)).toBeCloseTo(74.124, 3);
    created.itemIds.push(body.id);
    // Round-trip: GET the itinerary back and confirm coords persisted.
    const after = await get(request, token, `/api/travel/itineraries/${id}`);
    const items = (await after.json()).items || [];
    const persisted = items.find((it) => it.id === body.id);
    expect(persisted).toBeTruthy();
    expect(Number(persisted.latitude)).toBeCloseTo(15.2993, 4);
    expect(Number(persisted.longitude)).toBeCloseTo(74.124, 3);
  });

  test("POST /:id/items with lat=91 → 400 INVALID_LATITUDE (S118)", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token || created.itineraryIds.length === 0) test.skip(true, "no itineraries");
    const res = await post(
      request,
      token,
      `/api/travel/itineraries/${created.itineraryIds[0]}/items`,
      {
        itemType: "activity",
        description: `${RUN_TAG} bad lat`,
        latitude: 91,
        longitude: 0,
      },
    );
    expect(res.status()).toBe(400);
    expect((await res.json()).code).toBe("INVALID_LATITUDE");
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

  test("GET /itineraries/:id/pdf returns application/pdf with magic bytes", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token || !testContactId) test.skip(true, "deps missing");
    const created1 = await post(request, token, "/api/travel/itineraries", {
      subBrand: "rfu",
      contactId: testContactId,
      destination: `${RUN_TAG} pdf-target`,
      startDate: "2026-09-01",
      endDate: "2026-09-10",
      totalAmount: 125000,
      currency: "INR",
      items: [
        { itemType: "flight", description: "BLR-JED economy", unitCost: 35000, markup: 5000, totalPrice: 40000 },
        { itemType: "hotel", description: "Makkah Hilton — 7n", unitCost: 70000, markup: 8000, totalPrice: 78000 },
      ],
    });
    expect(created1.status()).toBe(201);
    const id = (await created1.json()).id;
    created.itineraryIds.push(id);

    const res = await get(request, token, `/api/travel/itineraries/${id}/pdf`);
    expect(res.status(), `pdf: ${await res.text().catch(() => "(non-text)")}`).toBe(200);
    expect(res.headers()["content-type"]).toMatch(/application\/pdf/);
    // First 4 bytes of any PDF file are the magic %PDF marker.
    const body = await res.body();
    expect(body.length).toBeGreaterThan(200);
    expect(body.slice(0, 4).toString("ascii")).toBe("%PDF");
  });

  test("GET /itineraries/:id/pdf for unknown id → 404 NOT_FOUND", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token) test.skip(true, "no token");
    const res = await get(request, token, "/api/travel/itineraries/99999999/pdf");
    expect(res.status()).toBe(404);
    expect((await res.json()).code).toBe("NOT_FOUND");
  });
});

// ─── Share-link expiry + revoke (PRD §4.7 document-security, gap A3) ──
//
// Policy under test (backend/lib/shareLinkPolicy.js):
//   - POST /:id/share accepts optional expiryDays, CLAMPED to [1, 30]
//     (default 7) → response carries shareExpiresAt.
//   - Public view of an expired link → 410 SHARE_EXPIRED; of a revoked
//     link → 410 SHARE_REVOKED (revoked wins over expired).
//   - POST /:id/share/revoke — idempotent, audited, owner-tenant scoped.
//   - Re-sharing AFTER a revoke mints a FRESH token; the revoked URL
//     stays dead (404 — the old token no longer exists on any row).
//
// Expiry is made deterministic via PATCH /:id { shareExpiresAt } (the
// advisor-facing shorten/extend control) — the spec back-dates the
// expiry instead of waiting days.
test.describe("Travel itineraries API — share expiry + revoke (PRD §4.7 gap A3)", () => {
  // Days between now and an ISO date — wide tolerances below absorb
  // client/server clock skew + request latency.
  const daysFromNow = (iso) => (new Date(iso).getTime() - Date.now()) / 86_400_000;

  async function createSentItinerary(request, token, label) {
    const res = await post(request, token, "/api/travel/itineraries", {
      subBrand: "rfu",
      contactId: testContactId,
      destination: `${RUN_TAG} ${label}`,
      status: "sent",
      totalAmount: 50000,
      currency: "INR",
    });
    expect(res.status(), `create ${label}: ${await res.text()}`).toBe(201);
    const id = (await res.json()).id;
    created.itineraryIds.push(id);
    return id;
  }

  test("share mint defaults shareExpiresAt to ~7 days out", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token || !testContactId) test.skip(true, "deps missing");
    const id = await createSentItinerary(request, token, "expiry-default");
    const res = await post(request, token, `/api/travel/itineraries/${id}/share`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.shareExpiresAt).toBeTruthy();
    const d = daysFromNow(body.shareExpiresAt);
    expect(d).toBeGreaterThan(6.5);
    expect(d).toBeLessThan(7.5);
  });

  test("expiryDays is clamped: 365 → 30 days, 0 → 1 day; in-window passes through", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token || !testContactId) test.skip(true, "deps missing");
    const id = await createSentItinerary(request, token, "expiry-clamp");

    // Above max → 30 (re-mint refreshes expiry on the same token).
    const high = await post(request, token, `/api/travel/itineraries/${id}/share`, { expiryDays: 365 });
    expect(high.status()).toBe(200);
    const dHigh = daysFromNow((await high.json()).shareExpiresAt);
    expect(dHigh).toBeGreaterThan(29.5);
    expect(dHigh).toBeLessThan(30.5);

    // Below min → 1.
    const low = await post(request, token, `/api/travel/itineraries/${id}/share`, { expiryDays: 0 });
    expect(low.status()).toBe(200);
    const dLow = daysFromNow((await low.json()).shareExpiresAt);
    expect(dLow).toBeGreaterThan(0.5);
    expect(dLow).toBeLessThan(1.5);

    // In-window → honored.
    const mid = await post(request, token, `/api/travel/itineraries/${id}/share`, { expiryDays: 14 });
    expect(mid.status()).toBe(200);
    const dMid = daysFromNow((await mid.json()).shareExpiresAt);
    expect(dMid).toBeGreaterThan(13.5);
    expect(dMid).toBeLessThan(14.5);
  });

  test("expired link → public view 410 SHARE_EXPIRED", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token || !testContactId) test.skip(true, "deps missing");
    const id = await createSentItinerary(request, token, "expiry-410");
    const share = await post(request, token, `/api/travel/itineraries/${id}/share`);
    expect(share.status()).toBe(200);
    const shareToken = (await share.json()).shareToken;

    // Link is live while unexpired.
    const live = await request.get(`${BASE_URL}/api/travel/itineraries/public/${shareToken}`, { timeout: REQUEST_TIMEOUT });
    expect(live.status()).toBe(200);

    // Back-date the expiry via the advisor PATCH control → 410.
    const backdate = await patch(request, token, `/api/travel/itineraries/${id}`, {
      shareExpiresAt: new Date(Date.now() - 60_000).toISOString(),
    });
    expect(backdate.status()).toBe(200);
    const after = await request.get(`${BASE_URL}/api/travel/itineraries/public/${shareToken}`, { timeout: REQUEST_TIMEOUT });
    expect(after.status()).toBe(410);
    expect((await after.json()).code).toBe("SHARE_EXPIRED");

    // Extending the expiry forward revives the SAME link (no revoke involved).
    const extend = await patch(request, token, `/api/travel/itineraries/${id}`, {
      shareExpiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    });
    expect(extend.status()).toBe(200);
    const revived = await request.get(`${BASE_URL}/api/travel/itineraries/public/${shareToken}`, { timeout: REQUEST_TIMEOUT });
    expect(revived.status()).toBe(200);
  });

  test("PATCH /:id with garbage shareExpiresAt → 400 INVALID_SHARE_EXPIRES_AT", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token || !testContactId) test.skip(true, "deps missing");
    const id = await createSentItinerary(request, token, "expiry-bad-date");
    const res = await patch(request, token, `/api/travel/itineraries/${id}`, { shareExpiresAt: "not-a-date" });
    expect(res.status()).toBe(400);
    expect((await res.json()).code).toBe("INVALID_SHARE_EXPIRES_AT");
  });

  test("revoke → 410 SHARE_REVOKED; idempotent re-revoke; re-share mints a FRESH token", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token || !testContactId) test.skip(true, "deps missing");
    const id = await createSentItinerary(request, token, "revoke-flow");
    const share = await post(request, token, `/api/travel/itineraries/${id}/share`);
    expect(share.status()).toBe(200);
    const originalToken = (await share.json()).shareToken;

    // Revoke.
    const revoke = await post(request, token, `/api/travel/itineraries/${id}/share/revoke`);
    expect(revoke.status()).toBe(200);
    const revokeBody = await revoke.json();
    expect(revokeBody.revoked).toBe(true);
    expect(revokeBody.shareRevokedAt).toBeTruthy();
    expect(revokeBody.alreadyRevoked).toBe(false);

    // Public view now 410 SHARE_REVOKED (revoked wins over any expiry state).
    const dead = await request.get(`${BASE_URL}/api/travel/itineraries/public/${originalToken}`, { timeout: REQUEST_TIMEOUT });
    expect(dead.status()).toBe(410);
    expect((await dead.json()).code).toBe("SHARE_REVOKED");

    // Second revoke is an idempotent no-op preserving the original stamp.
    const again = await post(request, token, `/api/travel/itineraries/${id}/share/revoke`);
    expect(again.status()).toBe(200);
    const againBody = await again.json();
    expect(againBody.alreadyRevoked).toBe(true);
    expect(againBody.shareRevokedAt).toBe(revokeBody.shareRevokedAt);

    // Re-share after revoke → FRESH token; the leaked URL stays dead forever.
    const reshare = await post(request, token, `/api/travel/itineraries/${id}/share`);
    expect(reshare.status()).toBe(200);
    const reshareBody = await reshare.json();
    expect(reshareBody.shareToken).toBeTruthy();
    expect(reshareBody.shareToken).not.toBe(originalToken);

    const oldUrl = await request.get(`${BASE_URL}/api/travel/itineraries/public/${originalToken}`, { timeout: REQUEST_TIMEOUT });
    expect(oldUrl.status()).toBe(404); // old token no longer exists on any row

    const newUrl = await request.get(`${BASE_URL}/api/travel/itineraries/public/${reshareBody.shareToken}`, { timeout: REQUEST_TIMEOUT });
    expect(newUrl.status()).toBe(200);
  });

  test("revoke on a never-shared itinerary → 409 NOT_SHARED", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token || !testContactId) test.skip(true, "deps missing");
    const id = await createSentItinerary(request, token, "revoke-unshared");
    const res = await post(request, token, `/api/travel/itineraries/${id}/share/revoke`);
    expect(res.status()).toBe(409);
    expect((await res.json()).code).toBe("NOT_SHARED");
  });

  test("revoke without token → 401/403; generic-vertical admin → 403 WRONG_VERTICAL", async ({ request }) => {
    const noAuth = await request.post(`${BASE_URL}/api/travel/itineraries/1/share/revoke`, {
      data: {},
      headers: { "Content-Type": "application/json" },
      timeout: REQUEST_TIMEOUT,
    });
    expect([401, 403]).toContain(noAuth.status());

    const genericToken = await getGenericAdmin(request);
    if (!genericToken) test.skip(true, "no generic admin token");
    const wrongVertical = await post(request, genericToken, "/api/travel/itineraries/1/share/revoke");
    expect(wrongVertical.status()).toBe(403);
    expect((await wrongVertical.json()).code).toBe("WRONG_VERTICAL");
  });
});

// Phase 2 (PRD §4.7) — Travel Stall 50%-advance booking flow on public
// itinerary share-token endpoints. Unauthenticated; allowlisted in
// server.js openPaths under /travel/itineraries/public.
test.describe("Travel itineraries API — Phase 2 public 50%-advance flow (PRD §4.7)", () => {
  const shared = { itineraryId: null, shareToken: null };

  test.beforeAll(async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token || !testContactId) return;
    // Mint a fresh itinerary with status='sent' + shareToken so the
    // public endpoints have something to read against. crypto.randomUUID()
    // gives a 36-char token which clears the 16-char public-route guard.
    const shareToken = `e2e-pub-${Date.now()}-${Math.random().toString(36).slice(2, 12)}-pad`;
    const res = await post(request, token, "/api/travel/itineraries", {
      subBrand: "travelstall",
      contactId: testContactId,
      destination: `${RUN_TAG} Bali`,
      startDate: "2026-10-01",
      endDate: "2026-10-08",
      totalAmount: 100000,
      currency: "INR",
      status: "sent",
      shareToken,
      items: [
        { itemType: "hotel", description: "Bali Resort 7n", totalPrice: 70000 },
        { itemType: "flight", description: "BLR-DPS economy", totalPrice: 30000 },
      ],
    });
    if (res.ok()) {
      const body = await res.json();
      shared.itineraryId = body.id;
      shared.shareToken = body.shareToken || shareToken;
      created.itineraryIds.push(body.id);
    }
  });

  test("GET /itineraries/public/:shareToken without token → 400 MISSING_TOKEN or 404", async ({ request }) => {
    // Short token fails the length guard.
    const res = await request.get(`${BASE_URL}/api/travel/itineraries/public/short`, { timeout: REQUEST_TIMEOUT });
    expect([400, 404]).toContain(res.status());
  });

  test("GET /itineraries/public/:shareToken with unknown token → 404 NOT_FOUND", async ({ request }) => {
    const res = await request.get(
      `${BASE_URL}/api/travel/itineraries/public/totally-fake-token-${Date.now()}-pad`,
      { timeout: REQUEST_TIMEOUT },
    );
    expect(res.status()).toBe(404);
  });

  test("GET /itineraries/public/:shareToken returns the public projection (no contactId leak)", async ({ request }) => {
    if (!shared.shareToken) test.skip(true, "seed itinerary missing");
    const res = await request.get(
      `${BASE_URL}/api/travel/itineraries/public/${shared.shareToken}`,
      { timeout: REQUEST_TIMEOUT },
    );
    expect(res.status(), `get: ${await res.text()}`).toBe(200);
    const body = await res.json();
    expect(body.shareToken).toBe(shared.shareToken);
    expect(body.subBrand).toBe("travelstall");
    expect(body.totalAmount).toBe(100000);
    // PRD §4.7 — advanceRatio is now sourced from the TenantSetting
    // helper (lib/tenantSettings.js). With no setting row seeded for
    // Travel Stall, the helper falls through to its hard-coded 0.5
    // baseline. RFU or other sub-brands with admin-set overrides
    // would return their override here instead.
    expect(body.advanceRatio).toBe(0.5);
    expect(body.advanceDue).toBe(50000);
    expect(body.advancePaid).toBe(0);
    expect(body.balanceDue).toBe(100000);
    expect(body.status).toBe("sent");
    expect(Array.isArray(body.items)).toBe(true);
    expect(body.items.length).toBe(2);
    // Public projection MUST NOT leak internals.
    expect(body).not.toHaveProperty("contactId");
    expect(body).not.toHaveProperty("leadId");
    expect(body).not.toHaveProperty("tenantId");
    for (const item of body.items) {
      // Cost / markup is internal — only totalPrice + description go out.
      expect(item).not.toHaveProperty("unitCost");
      expect(item).not.toHaveProperty("markup");
      expect(item).not.toHaveProperty("supplierId");
    }
  });

  test("GET /itineraries/public/:shareToken advanceRatio reflects the TenantSetting helper default (PRD §4.7)", async ({ request }) => {
    if (!shared.shareToken) test.skip(true, "seed itinerary missing");
    // Pins the post-Phase-2 contract: the public projection's
    // advanceRatio is sourced from getTravelAdvanceRatio() in
    // lib/tenantSettings.js. With no TenantSetting row for the demo
    // Travel Stall sub-brand, the helper falls through to its
    // hard-coded 0.5 baseline. If a future admin sets
    // `travel.advanceRatio.travelstall` to 0.4, this assertion will
    // need to flex — that's the whole point of the move.
    const res = await request.get(
      `${BASE_URL}/api/travel/itineraries/public/${shared.shareToken}`,
      { timeout: REQUEST_TIMEOUT },
    );
    expect(res.status()).toBe(200);
    const body = await res.json();
    // Ratio is in-bounds (0, 1].
    expect(body.advanceRatio).toBeGreaterThan(0);
    expect(body.advanceRatio).toBeLessThanOrEqual(1);
    // advanceDue is computed from ratio × total, rounded to 2dp.
    expect(body.advanceDue).toBe(
      Math.round(body.totalAmount * body.advanceRatio * 100) / 100,
    );
  });

  test("POST /record-advance-payment without body → 400 MISSING_FIELDS", async ({ request }) => {
    if (!shared.shareToken) test.skip(true, "seed itinerary missing");
    const res = await request.post(
      `${BASE_URL}/api/travel/itineraries/public/${shared.shareToken}/record-advance-payment`,
      { headers: { "Content-Type": "application/json" }, data: {}, timeout: REQUEST_TIMEOUT },
    );
    expect(res.status()).toBe(400);
    expect((await res.json()).code).toBe("MISSING_FIELDS");
  });

  test("POST /record-advance-payment with non-positive amount → 400 INVALID_AMOUNT", async ({ request }) => {
    if (!shared.shareToken) test.skip(true, "seed itinerary missing");
    const res = await request.post(
      `${BASE_URL}/api/travel/itineraries/public/${shared.shareToken}/record-advance-payment`,
      {
        headers: { "Content-Type": "application/json" },
        data: { amount: 0, paymentReference: "rzp_test_zero" },
        timeout: REQUEST_TIMEOUT,
      },
    );
    expect(res.status()).toBe(400);
    expect((await res.json()).code).toBe("INVALID_AMOUNT");
  });

  test("POST /record-advance-payment with 50% → status='advance_paid' + balanceDue computed", async ({ request }) => {
    if (!shared.shareToken) test.skip(true, "seed itinerary missing");
    const ref = `rzp_pay_50pc_${Date.now()}`;
    const res = await request.post(
      `${BASE_URL}/api/travel/itineraries/public/${shared.shareToken}/record-advance-payment`,
      {
        headers: { "Content-Type": "application/json" },
        data: { amount: 50000, paymentReference: ref },
        timeout: REQUEST_TIMEOUT,
      },
    );
    expect(res.status(), `record: ${await res.text()}`).toBe(201);
    const body = await res.json();
    expect(body.status).toBe("advance_paid");
    expect(body.advancePaidAmount).toBe(50000);
    expect(body.balanceDue).toBe(50000);
    expect(body.paymentReference).toBe(ref);
    expect(body.advancePaidAt).toBeTruthy();
  });

  test("POST /record-advance-payment with same paymentReference is idempotent", async ({ request }) => {
    if (!shared.shareToken) test.skip(true, "seed itinerary missing");
    // Re-fetch the current paymentReference (set by the previous test).
    const getRes = await request.get(
      `${BASE_URL}/api/travel/itineraries/public/${shared.shareToken}`,
      { timeout: REQUEST_TIMEOUT },
    );
    const current = await getRes.json();
    if (!current.advancePaidAt) test.skip(true, "advance not yet recorded; previous test failed");

    // The route stores `paymentReference` on the itinerary — but the GET
    // projection doesn't echo it. Re-derive via the same call shape that
    // set it. Idempotency is paymentReference-keyed, so replaying with
    // a fresh ref would double-count — we explicitly use the previously-
    // used ref.
    const lastRef = `rzp_pay_50pc_${current.advancePaidAt.slice(0, 4)}`; // approximation
    // The actual reference is `rzp_pay_50pc_<ms>`; we don't know the
    // exact ms from the projection. So re-fire with a NEW reference
    // expecting it to NOT short-circuit (this proves non-replay), then
    // re-fire that new ref expecting idempotent: true.
    const newRef = `rzp_idemp_${Date.now()}`;
    const r1 = await request.post(
      `${BASE_URL}/api/travel/itineraries/public/${shared.shareToken}/record-advance-payment`,
      {
        headers: { "Content-Type": "application/json" },
        data: { amount: 1, paymentReference: newRef },
        timeout: REQUEST_TIMEOUT,
      },
    );
    expect(r1.status()).toBe(201);
    const r2 = await request.post(
      `${BASE_URL}/api/travel/itineraries/public/${shared.shareToken}/record-advance-payment`,
      {
        headers: { "Content-Type": "application/json" },
        data: { amount: 1, paymentReference: newRef },
        timeout: REQUEST_TIMEOUT,
      },
    );
    expect(r2.status()).toBe(200);
    const body = await r2.json();
    expect(body.idempotent).toBe(true);
    expect(body.paymentReference).toBe(newRef);
    // Silently using lastRef to keep the unused-var lint quiet.
    void lastRef;
  });

  test("Draft itineraries are not publicly viewable (404 NOT_SHARED)", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token || !testContactId) test.skip(true, "deps missing");
    // Mint a draft itinerary.
    const draftToken = `e2e-draft-${Date.now()}-${Math.random().toString(36).slice(2, 12)}-pad`;
    const res = await post(request, token, "/api/travel/itineraries", {
      subBrand: "travelstall",
      contactId: testContactId,
      destination: `${RUN_TAG} Draft Phuket`,
      totalAmount: 80000,
      currency: "INR",
      status: "draft",
      shareToken: draftToken,
    });
    if (!res.ok()) test.skip(true, "could not seed draft");
    const draftId = (await res.json()).id;
    created.itineraryIds.push(draftId);

    const pubRes = await request.get(
      `${BASE_URL}/api/travel/itineraries/public/${draftToken}`,
      { timeout: REQUEST_TIMEOUT },
    );
    expect(pubRes.status()).toBe(404);
    expect((await pubRes.json()).code).toBe("NOT_SHARED");
  });
});

// ─── LLM draft regen (PRD §4.3 + §9.1) ───────────────────────────────
//
// Pins the 3rd-LLM-router-consumer endpoint at POST /itineraries/:id/draft/regen.
// First non-Claude-Opus consumer — exercises the bulk-text → gemini-flash
// routing path per PRD §9.1's locked Q11 routing table.
//
// CI runs without LLM API keys → router returns deterministic
// [STUB-BULK-TEXT] synthetic text and `stub: true`. When Q11 keys land
// the model identifier stays `gemini-flash` (primary for bulk-text);
// the stub flag flips to false and the text becomes real.
test.describe("Travel itineraries API — LLM draft regen (PRD §4.3 + §9.1)", () => {
  const shared = { itineraryId: null, shareToken: null };
  let userToken = null;

  async function getTravelUser(request) {
    if (!userToken) {
      userToken = await loginAs(request, "telecaller@travelstall.demo", "password123");
    }
    return userToken;
  }

  test.beforeAll(async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token || !testContactId) return;
    // Mint a fresh itinerary with items so the LLM payload has content
    // to summarise. shareToken set so the post-regen public-projection
    // test can read draftSummary back through the share endpoint.
    const shareToken = `e2e-draft-llm-${Date.now()}-${Math.random().toString(36).slice(2, 12)}-pad`;
    const res = await post(request, token, "/api/travel/itineraries", {
      subBrand: "rfu",
      contactId: testContactId,
      destination: `${RUN_TAG} Draft-regen Umrah`,
      startDate: "2026-08-01",
      endDate: "2026-08-10",
      totalAmount: 125000,
      currency: "INR",
      status: "sent",
      shareToken,
      items: [
        { itemType: "flight", description: "BOM-JED economy", totalPrice: 40000 },
        { itemType: "hotel", description: "Mecca 5-star 7n", totalPrice: 80000 },
      ],
    });
    if (res.ok()) {
      const body = await res.json();
      shared.itineraryId = body.id;
      shared.shareToken = body.shareToken || shareToken;
      created.itineraryIds.push(body.id);
    }
  });

  test("POST /itineraries/:id/draft/regen without auth → 401/403", async ({ request }) => {
    const res = await request.post(`${BASE_URL}/api/travel/itineraries/1/draft/regen`, {
      headers: { "Content-Type": "application/json" },
      data: {},
      timeout: REQUEST_TIMEOUT,
    });
    expect([401, 403]).toContain(res.status());
  });

  test("POST /itineraries/:id/draft/regen as USER role → 403 RBAC_DENIED (ADMIN/MANAGER only)", async ({ request }) => {
    const token = await getTravelUser(request);
    if (!token) test.skip(true, "telecaller@travelstall.demo not seeded — skipping RBAC test");
    if (!shared.itineraryId) test.skip(true, "seed itinerary missing");
    const res = await post(request, token, `/api/travel/itineraries/${shared.itineraryId}/draft/regen`, {});
    expect(res.status()).toBe(403);
    const body = await res.json();
    expect(body.code).toBe("RBAC_DENIED");
  });

  test("POST /itineraries/:id/draft/regen happy path → 201 with stub envelope", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token || !shared.itineraryId) test.skip(true, "seed itinerary missing");
    const res = await post(request, token, `/api/travel/itineraries/${shared.itineraryId}/draft/regen`, {});
    expect(res.status(), `regen: ${await res.text()}`).toBe(201);
    const body = await res.json();
    expect(body.id).toBe(shared.itineraryId);
    // PRD §9.1 — bulk-text task routes to Gemini Flash primary.
    expect(body.model).toBe("gemini-flash");
    // CI runs without LLM API keys → stub mode.
    expect(body.stub).toBe(true);
    expect(typeof body.draftSummary).toBe("string");
    expect(body.draftSummary.length).toBeGreaterThan(0);
    expect(body.draftSummary).toMatch(/STUB-BULK-TEXT/);
    // generatedAt must parse back to a valid Date.
    expect(Number.isFinite(Date.parse(body.generatedAt))).toBe(true);
  });

  test("GET /itineraries/:id after regen returns persisted draftSummary", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token || !shared.itineraryId) test.skip(true, "seed itinerary missing");
    const res = await get(request, token, `/api/travel/itineraries/${shared.itineraryId}`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(typeof body.draftSummary).toBe("string");
    expect(body.draftSummary).toMatch(/STUB-BULK-TEXT/);
  });

  test("GET /itineraries/public/:shareToken after regen surfaces draftSummary in the public projection", async ({ request }) => {
    if (!shared.shareToken) test.skip(true, "seed itinerary share token missing");
    const res = await request.get(
      `${BASE_URL}/api/travel/itineraries/public/${shared.shareToken}`,
      { timeout: REQUEST_TIMEOUT },
    );
    expect(res.status(), `public-get: ${await res.text()}`).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("draftSummary");
    expect(typeof body.draftSummary).toBe("string");
    expect(body.draftSummary).toMatch(/STUB-BULK-TEXT/);
  });

  test("POST /itineraries/:id/draft/regen with unknown id → 404 NOT_FOUND", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token) test.skip(true, "travel admin not available");
    const res = await post(request, token, "/api/travel/itineraries/9999999/draft/regen", {});
    expect(res.status()).toBe(404);
    const body = await res.json();
    expect(body.code).toBe("NOT_FOUND");
  });

  test("POST /itineraries/:id/draft/regen with non-numeric id → 400 INVALID_ID", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token) test.skip(true, "travel admin not available");
    const res = await post(request, token, "/api/travel/itineraries/abc/draft/regen", {});
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("INVALID_ID");
  });

  test("POST /itineraries/:id/draft/regen from generic-vertical caller → 403 WRONG_VERTICAL (cross-tenant guard)", async ({ request }) => {
    // requireTravelTenant rejects FIRST so a non-travel ADMIN can never
    // reach this endpoint regardless of itinerary id.
    const token = await getGenericAdmin(request);
    if (!token) test.skip(true, "admin@globussoft.com not seeded");
    const id = shared.itineraryId || 1;
    const res = await post(request, token, `/api/travel/itineraries/${id}/draft/regen`, {});
    expect(res.status()).toBe(403);
    const body = await res.json();
    expect(body.code).toBe("WRONG_VERTICAL");
  });
});

// ─── Slim-shape opt-in (#920 slice S3 — FR-3.5 PII payload reduction) ───
//
// `?fields=summary` on GET /itineraries drops shareToken (auth-bearing),
// pricingJson (heavy @db.Text), pdfUrl, micrositeUrl AND skips the
// `items` include. Default shape unchanged.

test.describe("Travel itineraries API — slim-shape opt-in (#920 S3)", () => {
  test("GET /itineraries?fields=summary returns slim projection (no shareToken, no pricingJson, no items include)", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token) test.skip(true, "travel admin not available");
    const res = await get(request, token, "/api/travel/itineraries?fields=summary");
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.itineraries)).toBe(true);
    if (body.itineraries.length === 0) test.skip(true, "no itineraries seeded yet");
    for (const it of body.itineraries) {
      expect(it).toHaveProperty("id");
      expect(it).toHaveProperty("subBrand");
      expect(it).toHaveProperty("contactId");
      expect(it).toHaveProperty("destination");
      expect(it).toHaveProperty("status");
      // SQL-dropped — never appear on slim path.
      expect(it).not.toHaveProperty("shareToken");
      expect(it).not.toHaveProperty("pricingJson");
      expect(it).not.toHaveProperty("pdfUrl");
      expect(it).not.toHaveProperty("micrositeUrl");
      // items include is SKIPPED on slim path.
      expect(it).not.toHaveProperty("items");
    }
  });

  test("GET /itineraries (default shape) still ships full row + items include", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token) test.skip(true, "travel admin not available");
    const res = await get(request, token, "/api/travel/itineraries");
    expect(res.status()).toBe(200);
    const body = await res.json();
    if (body.itineraries.length === 0) test.skip(true, "no itineraries seeded");
    const it = body.itineraries[0];
    expect(it).toHaveProperty("items"); // include still fires on default path
  });
});

// ─── S46: POST /api/travel/itineraries/suggest ───────────────────────
//
// SUBSUMED 2026-06-10 by `tests/travel-itinerary-suggest-api.spec.js`
// (PR #1142 / merge 8ba48fe8). The new PR shipped a second /suggest
// route handler (FR-3.4) at backend/routes/travel_itineraries.js:2563
// that is registered BEFORE the original FR-3.6/S14 handler (line 4263)
// — Express matches the first registered route, so all live traffic
// now hits the FR-3.4 handler. The response envelope changed from
// `{ suggestionJson, source, model, stub }` to
// `{ suggestion: { summary, days[{dayNumber,items[]}] }, model, stub, generatedAt, subBrand }`
// and the validation codes flipped (INVALID_DESTINATION →
// MISSING_DESTINATION, INVALID_DURATION_DAYS → INVALID_DAYS, request
// field `durationDays` → `days`).
//
// The new canonical contract (happy path + 400s + 401 + 403 + budget
// split) is pinned in full by `tests/travel-itinerary-suggest-api.spec.js`
// — that spec is in the per-push gate alongside this one. Keeping the
// old S46 assertions here would either duplicate the sibling spec or
// fail on the shape drift, so the block is removed.
//
// The older FR-3.6/S14 handler at routes/travel_itineraries.js:4263 is
// now unreachable dead code (same path as the FR-3.4 handler, registered
// later). A cleanup pass should delete it; until then, this note
// documents why no e2e assertion guards it.
//
// `tests/travel-itinerary-suggest-api.spec.js` covers:
//   - happy path returns { suggestion:{ summary, days[] }, model, stub }
//   - days array length === requested days; valid item set per day
//   - budget split lands on per-night hotel estimatedCost
//   - 400 MISSING_DESTINATION / INVALID_DAYS / INVALID_SUB_BRAND
//   - 401 unauthenticated
//   - 403 WRONG_VERTICAL on generic tenant

// ─── PRD FR-3.6 step (d) — POST /itineraries/from-suggestion (S90) ───
//
// Materialises an LLM/stub suggestion into a real Itinerary + N
// ItineraryItem rows. Mirror of the existing /suggest gate. Tests:
//   - happy round-trip (suggest → materialise → list contains new row)
//   - validation 400s (missing suggestionJson, empty daySplit, missing
//     contactId, item missing description, bad sub-brand)
//   - tenant-scope (generic-tenant caller → 403 WRONG_VERTICAL via the
//     same requireTravelTenant middleware that gates /suggest)
//   - PRD §4.1 diagnostic-first guard
test.describe("Travel itineraries API — POST /from-suggestion (PRD FR-3.6 step d)", () => {
  test("happy path: suggest → materialise produces an Itinerary + items", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token || !testContactId) test.skip(true, "deps missing");

    // 1. Build a synthetic suggestionJson directly — matches the from-
    //    suggestion route's expected input shape ({daySplit: [...]}). The
    //    PR #1142 /suggest handler reshaped its OUTPUT envelope (see the
    //    S46 subsumed note above) so we no longer round-trip through
    //    /suggest here; that endpoint's contract is pinned by the sibling
    //    tests/travel-itinerary-suggest-api.spec.js. The from-suggestion
    //    route still consumes the canonical FR-3.6 suggestionJson shape
    //    (daySplit/days). Items use valid VALID_ITEM_TYPES vocab so the
    //    materialise pass accepts them verbatim.
    const suggestionJson = {
      summary: `${RUN_TAG} Materialise Goa`,
      daySplit: [
        { dayNumber: 1, theme: "arrival", items: [{ itemType: "activity", description: "Day 1 sightseeing" }] },
        { dayNumber: 2, theme: "departure", items: [{ itemType: "activity", description: "Day 2 sightseeing" }] },
      ],
    };

    // 2. Materialise into a real Itinerary.
    const matRes = await post(request, token, "/api/travel/itineraries/from-suggestion", {
      suggestionJson,
      contactId: testContactId,
      subBrand: "rfu",
    });
    expect(matRes.status(), `materialise: ${await matRes.text()}`).toBe(201);
    const matBody = await matRes.json();
    expect(matBody.itinerary).toBeTruthy();
    expect(matBody.itinerary.id).toBeTruthy();
    expect(matBody.itemsCreated).toBeGreaterThan(0);
    expect(matBody.daysProcessed).toBe(2);
    expect(matBody.itinerary.status).toBe("draft");
    expect(Array.isArray(matBody.itinerary.items)).toBe(true);
    expect(matBody.itinerary.items.length).toBe(matBody.itemsCreated);
    // dayNumber populated on each item.
    expect(matBody.itinerary.items.every(
      (i) => Number.isFinite(i.dayNumber) && i.dayNumber >= 1,
    )).toBe(true);
    created.itineraryIds.push(matBody.itinerary.id);
  });

  test("missing suggestionJson → 400 INVALID_SUGGESTION_JSON", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token || !testContactId) test.skip(true, "deps missing");
    const res = await post(request, token, "/api/travel/itineraries/from-suggestion", {
      contactId: testContactId,
      subBrand: "rfu",
    });
    expect(res.status()).toBe(400);
    expect((await res.json()).code).toBe("INVALID_SUGGESTION_JSON");
  });

  test("empty daySplit → 400 INVALID_SUGGESTION_JSON", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token || !testContactId) test.skip(true, "deps missing");
    const res = await post(request, token, "/api/travel/itineraries/from-suggestion", {
      suggestionJson: { daySplit: [], summary: "empty" },
      contactId: testContactId,
      subBrand: "rfu",
    });
    expect(res.status()).toBe(400);
    expect((await res.json()).code).toBe("INVALID_SUGGESTION_JSON");
  });

  test("missing contactId → 400 CONTACT_ID_REQUIRED (schema gap)", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token) test.skip(true, "travel admin not available");
    const res = await post(request, token, "/api/travel/itineraries/from-suggestion", {
      suggestionJson: {
        daySplit: [{ dayNumber: 1, items: [{ itemType: "activity", description: "x" }] }],
      },
      subBrand: "rfu",
    });
    expect(res.status()).toBe(400);
    expect((await res.json()).code).toBe("CONTACT_ID_REQUIRED");
  });

  test("bad subBrand → 400 INVALID_SUB_BRAND", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token || !testContactId) test.skip(true, "deps missing");
    const res = await post(request, token, "/api/travel/itineraries/from-suggestion", {
      suggestionJson: {
        daySplit: [{ dayNumber: 1, items: [{ itemType: "activity", description: "x" }] }],
      },
      contactId: testContactId,
      subBrand: "made-up",
    });
    expect(res.status()).toBe(400);
    expect((await res.json()).code).toBe("INVALID_SUB_BRAND");
  });

  test("generic-vertical caller → 403 WRONG_VERTICAL (tenant-scope)", async ({ request }) => {
    const token = await getGenericAdmin(request);
    if (!token) test.skip(true, "generic admin not seeded");
    const res = await post(request, token, "/api/travel/itineraries/from-suggestion", {
      suggestionJson: {
        daySplit: [{ dayNumber: 1, items: [{ itemType: "activity", description: "x" }] }],
      },
      contactId: 1,
      subBrand: "rfu",
    });
    expect(res.status()).toBe(403);
    expect((await res.json()).code).toBe("WRONG_VERTICAL");
  });

  test("unauthenticated → 401/403", async ({ request }) => {
    const res = await request.post(`${BASE_URL}/api/travel/itineraries/from-suggestion`, {
      headers: { "Content-Type": "application/json" },
      data: {
        suggestionJson: {
          daySplit: [{ dayNumber: 1, items: [{ itemType: "activity", description: "x" }] }],
        },
        contactId: 1,
        subBrand: "rfu",
      },
      timeout: REQUEST_TIMEOUT,
    });
    expect([401, 403]).toContain(res.status());
  });

  test("G051 — materialised items have draftedByAi=true on every item", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token || !testContactId) test.skip(true, "deps missing");
    const suggestionJson = {
      summary: `${RUN_TAG} AI provenance Goa`,
      daySplit: [
        { dayNumber: 1, items: [
          { itemType: "activity", description: "Day 1 sightseeing" },
          { itemType: "meals", description: "Day 1 dinner" },
        ] },
      ],
    };
    const res = await post(request, token, "/api/travel/itineraries/from-suggestion", {
      suggestionJson, contactId: testContactId, subBrand: "rfu",
    });
    expect(res.status(), `materialise: ${await res.text()}`).toBe(201);
    const body = await res.json();
    expect(body.itinerary.items.length).toBeGreaterThan(0);
    for (const it of body.itinerary.items) {
      expect(it.draftedByAi).toBe(true);
    }
    created.itineraryIds.push(body.itinerary.id);
  });
});

// ─── G047 + G049 lineage round-trip (PRD FR-3.1.e + FR-3.1.h) ────────
//
// End-to-end: create an ItineraryTemplate → POST /itineraries with
// clonedFromTemplateId → GET the parent template back and confirm
// usageCount was bumped + lastUsedAt is fresh → POST /:id/accept on
// the cloned itinerary → GET the template again and confirm
// acceptedCount was bumped + avgFinalPrice was recomputed.
//
// Demo-safe: every artifact is RUN_TAG-prefixed and cleaned up in
// afterAll. The accept-fan-out (web-checkin auto-create + webhook
// emission) is non-fatal and out of scope here.

test.describe("Travel itineraries API — G047/G049 lineage round-trip", () => {
  let templateId = null;
  let lineageItineraryId = null;

  test.afterAll(async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token) return;
    if (lineageItineraryId) {
      await del(request, token, `/api/travel/itineraries/${lineageItineraryId}`).catch(() => {});
    }
    if (templateId) {
      await del(request, token, `/api/travel/itinerary-templates/${templateId}`).catch(() => {});
    }
  });

  test("create template → clone-from → template usageCount + lastUsedAt bumped", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token || !testContactId) test.skip(true, "deps missing");

    // 1. Seed a fresh ItineraryTemplate scoped to this tenant + rfu.
    const tplRes = await post(request, token, "/api/travel/itinerary-templates", {
      name: `${RUN_TAG} Lineage Template`,
      destinationName: `${RUN_TAG} Mecca`,
      durationDays: 7,
      category: "religious",
      subBrand: "rfu",
      basePriceMinor: 12000000,
      currency: "INR",
    });
    expect(tplRes.status(), `tpl create: ${await tplRes.text()}`).toBe(201);
    const tplBody = await tplRes.json();
    templateId = tplBody.id;
    // Fresh template has usageCount=0 + acceptedCount=0 + lastUsedAt=null.
    expect(tplBody.usageCount).toBe(0);
    expect(tplBody.acceptedCount).toBe(0);
    expect(tplBody.lastUsedAt == null).toBe(true);

    // 2. Create an Itinerary clonedFromTemplateId → the new lineage column.
    const t0 = Date.now();
    const itRes = await post(request, token, "/api/travel/itineraries", {
      subBrand: "rfu",
      contactId: testContactId,
      destination: `${RUN_TAG} Cloned Umrah`,
      totalAmount: 175000,
      currency: "INR",
      clonedFromTemplateId: templateId,
    });
    expect(itRes.status(), `clone create: ${await itRes.text()}`).toBe(201);
    const itBody = await itRes.json();
    lineageItineraryId = itBody.id;
    expect(itBody.clonedFromTemplateId).toBe(templateId);

    // 3. Refetch the template + assert metrics bumped.
    const tpl2 = await get(request, token, `/api/travel/itinerary-templates/${templateId}`);
    expect(tpl2.status()).toBe(200);
    const tpl2Body = await tpl2.json();
    expect(tpl2Body.usageCount).toBe(1);
    expect(tpl2Body.lastUsedAt).toBeTruthy();
    const lastUsedMs = new Date(tpl2Body.lastUsedAt).getTime();
    expect(lastUsedMs).toBeGreaterThanOrEqual(t0 - 5000);
    expect(lastUsedMs).toBeLessThanOrEqual(Date.now() + 5000);
    // acceptedCount still 0 until we hit /accept.
    expect(tpl2Body.acceptedCount).toBe(0);
  });

  test("accept cloned itinerary → template.acceptedCount++ + avgFinalPrice recomputed", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token || !lineageItineraryId || !templateId) test.skip(true, "deps missing");

    const accRes = await post(request, token, `/api/travel/itineraries/${lineageItineraryId}/accept`);
    expect([200, 409], `accept: ${await accRes.text()}`).toContain(accRes.status());

    // Refetch template + verify rolling-avg formula on the first accept.
    const tpl = await get(request, token, `/api/travel/itinerary-templates/${templateId}`);
    expect(tpl.status()).toBe(200);
    const body = await tpl.json();
    if (accRes.status() === 200) {
      expect(body.acceptedCount).toBe(1);
      expect(Number(body.avgFinalPrice)).toBe(175000);
    }
  });

  test("cross-tenant clonedFromTemplateId → 404 TEMPLATE_NOT_FOUND", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token || !testContactId) test.skip(true, "deps missing");
    const res = await post(request, token, "/api/travel/itineraries", {
      subBrand: "rfu",
      contactId: testContactId,
      destination: `${RUN_TAG} Cross-tenant clone attempt`,
      // 999999999 is guaranteed not to exist in any reasonable seed.
      clonedFromTemplateId: 999999999,
    });
    expect(res.status()).toBe(404);
    expect((await res.json()).code).toBe("TEMPLATE_NOT_FOUND");
  });
});
