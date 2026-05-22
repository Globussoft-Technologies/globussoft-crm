// @ts-check
/**
 * Gate spec — Religious-guidance content library CRUD (PRD §4.8 +
 * §4.10 RFU). Admin-curated content packets fired by the daily
 * religiousGuidanceEngine cron. Library is editable here so admin
 * PATCH takes effect on the next cron tick without redeployment.
 *
 * Mirrors travel-rfu-profiles-api.spec.js auth + setup pattern.
 *
 * Pins:
 *   - guards: no-auth → 401/403, generic admin → 403 WRONG_VERTICAL,
 *             USER role → 403 on writes
 *   - POST happy path → 201 + the right shape (subBrand, dayOffset,
 *     title, contentHtml, channels, isActive defaulting to true)
 *   - POST validation: missing fields → MISSING_FIELDS, invalid
 *     subBrand → INVALID_SUB_BRAND, invalid dayOffset → INVALID_DAY_OFFSET,
 *     invalid channels → INVALID_CHANNELS
 *   - GET list filters by ?subBrand= and ?isActive=
 *   - GET :id returns the packet shape
 *   - PATCH amends; PATCH empty → EMPTY_BODY; PATCH invalid channels → 400
 *   - DELETE removes
 */

const { test, expect } = require("@playwright/test");

test.describe.configure({ mode: "serial" });

const BASE_URL = process.env.BASE_URL || "https://crm.globusdemos.com";
const REQUEST_TIMEOUT = 60000;
const RUN_TAG = `E2E_TRAVEL_RELIGIOUS_${Date.now()}`;

let travelAdminToken = null;
let travelUserToken = null;
let genericAdminToken = null;

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
async function getTravelUser(request) {
  if (!travelUserToken) {
    travelUserToken = await loginAs(request, "telecaller@travelstall.demo", "password123");
  }
  return travelUserToken;
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
  return retryOn5xx(() => request.delete(`${BASE_URL}${path}`, { headers: headers(token), timeout: REQUEST_TIMEOUT }));
}

const created = { packetIds: [] };

test.afterAll(async ({ request }) => {
  const token = await getTravelAdmin(request);
  if (!token) return;
  for (const id of created.packetIds) {
    await del(request, token, `/api/travel/religious-packets/${id}`).catch(() => {});
  }
});

test.describe("Travel religious-packets API — guards", () => {
  test("GET /religious-packets without auth → 401/403", async ({ request }) => {
    const res = await request.get(`${BASE_URL}/api/travel/religious-packets`, { timeout: REQUEST_TIMEOUT });
    expect([401, 403]).toContain(res.status());
  });

  test("GET /religious-packets rejects generic admin with 403 WRONG_VERTICAL", async ({ request }) => {
    const token = await getGenericAdmin(request);
    if (!token) test.skip(true, "admin@globussoft.com not seeded");
    const res = await get(request, token, "/api/travel/religious-packets");
    expect(res.status()).toBe(403);
    expect((await res.json()).code).toBe("WRONG_VERTICAL");
  });

  test("POST /religious-packets rejects non-ADMIN user with 403", async ({ request }) => {
    const token = await getTravelUser(request);
    if (!token) test.skip(true, "telecaller@travelstall.demo not seeded");
    const res = await post(request, token, "/api/travel/religious-packets", {
      subBrand: "rfu",
      dayOffset: 10,
      title: `${RUN_TAG} should not save`,
      contentHtml: "<p>x</p>",
    });
    expect(res.status()).toBe(403);
  });
});

test.describe("Travel religious-packets API — CRUD happy path", () => {
  test("POST creates a packet at T-10d with default channels", async ({ request }) => {
    const token = await getTravelAdmin(request);
    expect(token).toBeTruthy();
    const res = await post(request, token, "/api/travel/religious-packets", {
      subBrand: "rfu",
      dayOffset: 10,
      title: `${RUN_TAG} ten days out`,
      contentHtml: "<p>Ten-day pre-departure reminder (E2E placeholder).</p>",
    });
    expect(res.status(), `create: ${await res.text()}`).toBe(201);
    const body = await res.json();
    expect(body.subBrand).toBe("rfu");
    expect(body.dayOffset).toBe(10);
    expect(body.title).toBe(`${RUN_TAG} ten days out`);
    expect(body.channels).toBe("wa,email"); // default
    expect(body.isActive).toBe(true); // default
    expect(typeof body.id).toBe("number");
    created.packetIds.push(body.id);
  });

  test("POST with explicit channels=wa,sms persists exactly that", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token) test.skip(true, "no token");
    const res = await post(request, token, "/api/travel/religious-packets", {
      subBrand: "rfu",
      dayOffset: 5,
      title: `${RUN_TAG} five days out`,
      contentHtml: "<p>Five-day reminder.</p>",
      channels: "wa,sms",
      isActive: false,
    });
    expect(res.status()).toBe(201);
    const body = await res.json();
    expect(body.channels).toBe("wa,sms");
    expect(body.isActive).toBe(false);
    created.packetIds.push(body.id);
  });

  test("POST missing required fields → 400 MISSING_FIELDS", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token) test.skip(true, "no token");
    const res = await post(request, token, "/api/travel/religious-packets", {
      subBrand: "rfu",
      // missing dayOffset, title, contentHtml
    });
    expect(res.status()).toBe(400);
    expect((await res.json()).code).toBe("MISSING_FIELDS");
  });

  test("POST invalid subBrand → 400 INVALID_SUB_BRAND", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token) test.skip(true, "no token");
    const res = await post(request, token, "/api/travel/religious-packets", {
      subBrand: "bogus",
      dayOffset: 5,
      title: `${RUN_TAG} bogus brand`,
      contentHtml: "<p>x</p>",
    });
    expect(res.status()).toBe(400);
    expect((await res.json()).code).toBe("INVALID_SUB_BRAND");
  });

  test("POST invalid dayOffset (negative) → 400 INVALID_DAY_OFFSET", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token) test.skip(true, "no token");
    const res = await post(request, token, "/api/travel/religious-packets", {
      subBrand: "rfu",
      dayOffset: -3,
      title: `${RUN_TAG} negative`,
      contentHtml: "<p>x</p>",
    });
    expect(res.status()).toBe(400);
    expect((await res.json()).code).toBe("INVALID_DAY_OFFSET");
  });

  test("POST invalid channels (contains 'whatsapp' not in whitelist) → 400 INVALID_CHANNELS", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token) test.skip(true, "no token");
    const res = await post(request, token, "/api/travel/religious-packets", {
      subBrand: "rfu",
      dayOffset: 5,
      title: `${RUN_TAG} bad channels`,
      contentHtml: "<p>x</p>",
      channels: "wa,whatsapp",
    });
    expect(res.status()).toBe(400);
    expect((await res.json()).code).toBe("INVALID_CHANNELS");
  });

  test("GET list filters by ?subBrand=rfu", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token || created.packetIds.length === 0) test.skip(true, "no packets");
    const res = await get(request, token, "/api/travel/religious-packets?subBrand=rfu");
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.packets)).toBe(true);
    expect(body.packets.every((p) => p.subBrand === "rfu")).toBe(true);
    // Our 2 freshly-created packets must be in the list
    const ids = body.packets.map((p) => p.id);
    for (const id of created.packetIds) expect(ids).toContain(id);
  });

  test("GET list filters by ?isActive=false", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token || created.packetIds.length < 2) test.skip(true, "need ≥2 packets");
    const res = await get(request, token, "/api/travel/religious-packets?isActive=false&limit=200");
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.packets.every((p) => p.isActive === false)).toBe(true);
  });

  test("GET :id returns the packet", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token || created.packetIds.length === 0) test.skip(true, "no packets");
    const id = created.packetIds[0];
    const res = await get(request, token, `/api/travel/religious-packets/${id}`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.id).toBe(id);
    expect(body.subBrand).toBe("rfu");
  });

  test("GET :id with unknown id → 404 NOT_FOUND", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token) test.skip(true, "no token");
    const res = await get(request, token, "/api/travel/religious-packets/99999999");
    expect(res.status()).toBe(404);
    expect((await res.json()).code).toBe("NOT_FOUND");
  });

  test("PATCH amends title + isActive", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token || created.packetIds.length === 0) test.skip(true, "no packets");
    const id = created.packetIds[0];
    const res = await patch(request, token, `/api/travel/religious-packets/${id}`, {
      title: `${RUN_TAG} amended title`,
      isActive: false,
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.title).toBe(`${RUN_TAG} amended title`);
    expect(body.isActive).toBe(false);
  });

  test("PATCH empty body → 400 EMPTY_BODY", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token || created.packetIds.length === 0) test.skip(true, "no packets");
    const id = created.packetIds[0];
    const res = await patch(request, token, `/api/travel/religious-packets/${id}`, {});
    expect(res.status()).toBe(400);
    expect((await res.json()).code).toBe("EMPTY_BODY");
  });

  test("PATCH invalid channels → 400 INVALID_CHANNELS", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token || created.packetIds.length === 0) test.skip(true, "no packets");
    const id = created.packetIds[0];
    const res = await patch(request, token, `/api/travel/religious-packets/${id}`, {
      channels: "wa, email", // space after comma — invalid per regex
    });
    expect(res.status()).toBe(400);
    expect((await res.json()).code).toBe("INVALID_CHANNELS");
  });

  test("PATCH rejects non-ADMIN user with 403", async ({ request }) => {
    const userToken = await getTravelUser(request);
    if (!userToken || created.packetIds.length === 0) test.skip(true, "deps missing");
    const id = created.packetIds[0];
    const res = await patch(request, userToken, `/api/travel/religious-packets/${id}`, {
      title: "user should not write",
    });
    expect(res.status()).toBe(403);
  });

  test("DELETE removes the packet", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token || created.packetIds.length < 2) test.skip(true, "need ≥2 packets");
    // Delete the 2nd one so the afterAll cleanup doesn't double-delete
    // the first (we still want the first around for the get-after-delete
    // 404 assertion in this same describe).
    const id = created.packetIds.pop();
    const res = await del(request, token, `/api/travel/religious-packets/${id}`);
    expect(res.status()).toBe(200);
    expect((await res.json()).deleted).toBe(true);

    // Confirm 404 on the deleted id
    const after = await get(request, token, `/api/travel/religious-packets/${id}`);
    expect(after.status()).toBe(404);
  });
});
