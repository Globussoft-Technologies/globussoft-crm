// @ts-check
/**
 * Gate spec — RfuLeadProfile CRUD (RFU customer profile extension).
 *
 * Pins the Day 11 commit. One-to-one with Contact (schema @unique on
 * contactId), so the spec also pins the duplicate-create 409 behaviour.
 */

const { test, expect } = require("@playwright/test");

test.describe.configure({ mode: "serial" });

const BASE_URL = process.env.BASE_URL || "https://crm.globusdemos.com";
const REQUEST_TIMEOUT = 60000;
const RUN_TAG = `E2E_TRAVEL_RFU_${Date.now()}`;

let travelAdminToken = null;
let genericAdminToken = null;
let contactId = null;

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

const created = { profileIds: [] };

test.beforeAll(async ({ request }) => {
  const token = await getTravelAdmin(request);
  if (!token) return;
  const cRes = await post(request, token, "/api/contacts", {
    name: `${RUN_TAG} Pilgrim Kavita`,
    email: `${RUN_TAG.toLowerCase()}-pilgrim@e2e.test`,
    phone: `+91${String(Date.now()).slice(-10)}`,
    subBrand: "rfu",
  });
  if (cRes.ok()) {
    contactId = (await cRes.json()).id;
  }
});

test.afterAll(async ({ request }) => {
  const token = await getTravelAdmin(request);
  if (!token) return;
  for (const id of created.profileIds) {
    await del(request, token, `/api/travel/rfu-profiles/${id}`).catch(() => {});
  }
  if (contactId) {
    await del(request, token, `/api/contacts/${contactId}`).catch(() => {});
  }
});

test.describe("Travel RFU profiles API — guards", () => {
  test("GET /rfu-profiles rejects generic admin with 403 WRONG_VERTICAL", async ({ request }) => {
    const token = await getGenericAdmin(request);
    if (!token) test.skip(true, "admin@globussoft.com not seeded");
    const res = await get(request, token, "/api/travel/rfu-profiles");
    expect(res.status()).toBe(403);
    expect((await res.json()).code).toBe("WRONG_VERTICAL");
  });

  test("GET /rfu-profiles without auth → 401/403", async ({ request }) => {
    const res = await request.get(`${BASE_URL}/api/travel/rfu-profiles`, { timeout: REQUEST_TIMEOUT });
    expect([401, 403]).toContain(res.status());
  });
});

test.describe("Travel RFU profiles API — CRUD", () => {
  test("POST creates a profile for the contact", async ({ request }) => {
    const token = await getTravelAdmin(request);
    expect(token).toBeTruthy();
    expect(contactId).toBeTruthy();
    const res = await post(request, token, "/api/travel/rfu-profiles", {
      contactId,
      passportNumber: "K9876543",
      passportExpiry: "2030-12-31",
      seatPref: "aisle",
      mealPref: "halal",
      travelStyle: "premium-haram-view",
      budgetMin: 80000,
      budgetMax: 250000,
      productTier: "premium",
      emergencyContactName: "Mrs. Reddy",
      emergencyContactPhone: "+919876512345",
    });
    expect(res.status(), `create: ${await res.text()}`).toBe(201);
    const body = await res.json();
    expect(body.contactId).toBe(contactId);
    expect(body.passportNumber).toBe("K9876543");
    expect(body.productTier).toBe("premium");
    expect(Number(body.budgetMin)).toBe(80000);
    expect(Number(body.budgetMax)).toBe(250000);
    created.profileIds.push(body.id);
  });

  test("POST again for the same contact → 409 DUPLICATE_PROFILE", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token || !contactId) test.skip(true, "deps missing");
    const res = await post(request, token, "/api/travel/rfu-profiles", { contactId });
    expect(res.status()).toBe(409);
    expect((await res.json()).code).toBe("DUPLICATE_PROFILE");
  });

  test("POST with missing contactId → 400 MISSING_FIELDS", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token) test.skip(true, "no token");
    const res = await post(request, token, "/api/travel/rfu-profiles", {});
    expect(res.status()).toBe(400);
    expect((await res.json()).code).toBe("MISSING_FIELDS");
  });

  test("POST with bad productTier → 400 INVALID_TIER", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token) test.skip(true, "no token");
    // Use a fake contactId so we don't trigger the dup-profile guard.
    const res = await post(request, token, "/api/travel/rfu-profiles", {
      contactId: 9999999,
      productTier: "elite",
    });
    expect(res.status()).toBe(400);
    expect((await res.json()).code).toBe("INVALID_TIER");
  });

  test("GET /rfu-profiles?productTier=premium filters", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token || created.profileIds.length === 0) test.skip(true, "no profiles");
    const res = await get(request, token, "/api/travel/rfu-profiles?productTier=premium");
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.profiles)).toBe(true);
    expect(body.profiles.every((p) => p.productTier === "premium")).toBe(true);
  });

  test("GET /rfu-profiles?productTier=bogus → 400 INVALID_TIER", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token) test.skip(true, "no token");
    const res = await get(request, token, "/api/travel/rfu-profiles?productTier=bogus");
    expect(res.status()).toBe(400);
    expect((await res.json()).code).toBe("INVALID_TIER");
  });

  test("GET /rfu-profiles/by-contact/:contactId returns the profile", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token || !contactId) test.skip(true, "no contact");
    const res = await get(request, token, `/api/travel/rfu-profiles/by-contact/${contactId}`);
    expect(res.status()).toBe(200);
    expect((await res.json()).contactId).toBe(contactId);
  });

  test("GET /rfu-profiles/by-contact/:cid with unknown contact → 404", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token) test.skip(true, "no token");
    const res = await get(request, token, "/api/travel/rfu-profiles/by-contact/9999999");
    expect(res.status()).toBe(404);
    expect((await res.json()).code).toBe("NOT_FOUND");
  });

  test("PATCH amends budget + tier", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token || created.profileIds.length === 0) test.skip(true, "no profile");
    const res = await patch(request, token, `/api/travel/rfu-profiles/${created.profileIds[0]}`, {
      budgetMax: 300000,
      productTier: "primary",
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Number(body.budgetMax)).toBe(300000);
    expect(body.productTier).toBe("primary");
  });

  test("PATCH with invalid tier → 400 INVALID_TIER", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token || created.profileIds.length === 0) test.skip(true, "no profile");
    const res = await patch(request, token, `/api/travel/rfu-profiles/${created.profileIds[0]}`, {
      productTier: "ultra",
    });
    expect(res.status()).toBe(400);
    expect((await res.json()).code).toBe("INVALID_TIER");
  });

  test("PATCH empty body → 400 EMPTY_BODY", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token || created.profileIds.length === 0) test.skip(true, "no profile");
    const res = await patch(request, token, `/api/travel/rfu-profiles/${created.profileIds[0]}`, {});
    expect(res.status()).toBe(400);
    expect((await res.json()).code).toBe("EMPTY_BODY");
  });
});
