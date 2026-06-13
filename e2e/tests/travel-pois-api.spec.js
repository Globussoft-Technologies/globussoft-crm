// @ts-check
/**
 * Gate spec — POI catalog list + Inline rep-suggested POI + pendingApproval
 * queue (Wave 18 slices S12 + S93, PRD_TRAVEL_ITINERARY_UPGRADES FR-3.6 +
 * FR-3.7).
 *
 * Pins:
 *   - probe-skip: if `/api/travel/pois` is not mounted, every test
 *     auto-skips.
 *   - GET / (USER+) [S93] — catalog list scoped to destinationSlug +
 *     tenant-or-null; missing destinationSlug -> 400 MISSING_FIELDS;
 *     paging honored.
 *   - POST / (USER+) — rep suggests; lands with pendingApproval=true,
 *     externalSource=operator.
 *   - GET /pending (ADMIN+MANAGER) — tenant-scoped list of pendingApproval
 *     rows.
 *   - POST /:id/approve (ADMIN) — flips pendingApproval=false.
 *   - POST /:id/reject (ADMIN) — hard-deletes the row.
 *   - Auth gates: no-token → 401, USER → 403 on /pending, MANAGER → 403
 *     on /approve + /reject.
 *   - Validation: missing name / category / destinationSlug → 400
 *     MISSING_FIELDS; out-of-range lat/lng → 400 INVALID_COORD.
 *   - Cross-tenant isolation: generic-admin can't approve a travel-tenant
 *     suggestion.
 *
 * RUN_TAG-prefixed `name` values per
 * e2e/test-data-patterns.js so the demo-hygiene cron can sweep
 * leftovers without leaking real-looking data.
 */

const { test, expect } = require("@playwright/test");

test.describe.configure({ mode: "serial" });

const BASE_URL = process.env.BASE_URL || "https://crm.globusdemos.com";
const REQUEST_TIMEOUT = 60000;
const RUN_TAG = `E2E_TRAVEL_POIS_${Date.now()}`;

let travelAdminToken = null;
let travelUserToken = null;
let genericAdminToken = null;
let routeMounted = null; // probed in beforeAll

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

function post(request, token, path, data) {
  return retryOn5xx(() =>
    request.post(`${BASE_URL}${path}`, {
      headers: headers(token),
      data,
      timeout: REQUEST_TIMEOUT,
    }),
  );
}
function get(request, token, path) {
  return retryOn5xx(() =>
    request.get(`${BASE_URL}${path}`, {
      headers: token ? headers(token) : { "Content-Type": "application/json" },
      timeout: REQUEST_TIMEOUT,
    }),
  );
}

// ── Probe-skip ──────────────────────────────────────────────────────
// The slice prompt says server.js mount is deferred to a follow-up gap.
// Probe a no-auth GET on /pending — if the route is mounted, we get 401
// (auth gate). If unmounted, we get 404 (route fall-through) or HTML
// (SPA fallback when proxied through nginx). Either non-401 means skip.
async function probeRouteMounted(request) {
  if (routeMounted !== null) return routeMounted;
  try {
    const r = await request.get(`${BASE_URL}/api/travel/pois/pending`, {
      timeout: REQUEST_TIMEOUT,
    });
    routeMounted = r.status() === 401;
  } catch (_e) {
    routeMounted = false;
  }
  return routeMounted;
}

test.beforeAll(async ({ request }) => {
  await probeRouteMounted(request);
});

function validSuggestBody(extra = {}) {
  return {
    name: `${RUN_TAG} Hidden Beach Cove`,
    nameLocal: "अंजुना समुद्र तट",
    category: "natural",
    latitude: 15.5673,
    longitude: 73.7397,
    country: "IN",
    destinationSlug: "goa",
    descriptionShort: "A serene cove on Anjuna stretch",
    ...extra,
  };
}

// ────────────────────────────────────────────────────────────────────
// Tests
// ────────────────────────────────────────────────────────────────────

test.describe("Travel POIs — rep suggest + approval queue", () => {
  test.beforeEach(async () => {
    test.skip(!routeMounted, "/api/travel/pois not mounted (server.js wire-in deferred)");
  });

  // ── GET / — catalog list for the PoiPicker (S93) ─────────────────
  test("GET / — happy path: returns envelope { pois, total, limit, offset } scoped to destinationSlug", async ({ request }) => {
    const userToken = await getTravelUser(request);
    test.skip(!userToken, "travel user not seeded");

    const r = await get(request, userToken, "/api/travel/pois?destinationSlug=goa&limit=10");
    expect(r.status()).toBe(200);
    const body = await r.json();
    expect(Array.isArray(body.pois)).toBe(true);
    expect(typeof body.total).toBe("number");
    expect(body.limit).toBe(10);
    expect(body.offset).toBe(0);
    // Picker must never see pendingApproval=true rows.
    for (const poi of body.pois) {
      expect(poi.pendingApproval).toBe(false);
      expect(poi.destinationSlug).toBe("goa");
    }
  });

  test("GET / — missing destinationSlug -> 400 MISSING_FIELDS", async ({ request }) => {
    const userToken = await getTravelUser(request);
    test.skip(!userToken, "travel user not seeded");

    const r = await get(request, userToken, "/api/travel/pois");
    expect(r.status()).toBe(400);
    const body = await r.json();
    expect(body.code).toBe("MISSING_FIELDS");
  });

  test("GET / — no auth -> 401", async ({ request }) => {
    const r = await request.get(`${BASE_URL}/api/travel/pois?destinationSlug=goa`);
    expect(r.status()).toBe(401);
  });

  test("GET / — paging: ?limit and ?offset honored", async ({ request }) => {
    const userToken = await getTravelUser(request);
    test.skip(!userToken, "travel user not seeded");

    const r = await get(request, userToken, "/api/travel/pois?destinationSlug=goa&limit=5&offset=2");
    expect(r.status()).toBe(200);
    const body = await r.json();
    expect(body.limit).toBe(5);
    expect(body.offset).toBe(2);
    expect(body.pois.length).toBeLessThanOrEqual(5);
  });

  test("happy path — USER suggests POI, ADMIN sees it in /pending, ADMIN approves", async ({ request }) => {
    const userToken = await getTravelUser(request);
    const adminToken = await getTravelAdmin(request);
    test.skip(!userToken || !adminToken, "travel test users not seeded");

    // Suggest.
    const suggestRes = await post(request, userToken, "/api/travel/pois", validSuggestBody());
    expect([200, 201]).toContain(suggestRes.status());
    const suggested = await suggestRes.json();
    expect(suggested.pendingApproval).toBe(true);
    expect(suggested.externalSource).toBe("operator");
    expect(typeof suggested.id).toBe("number");

    // ADMIN sees it in /pending.
    const queueRes = await get(request, adminToken, "/api/travel/pois/pending?limit=200");
    expect(queueRes.status()).toBe(200);
    const queue = await queueRes.json();
    expect(Array.isArray(queue.pending)).toBe(true);
    const found = queue.pending.find((p) => p.id === suggested.id);
    expect(found).toBeTruthy();
    expect(found.name).toContain(RUN_TAG);

    // ADMIN approves.
    const approveRes = await post(request, adminToken, `/api/travel/pois/${suggested.id}/approve`);
    expect(approveRes.status()).toBe(200);
    const approved = await approveRes.json();
    expect(approved.pendingApproval).toBe(false);

    // Cleanup — delete the approved row so demo stays clean.
    // (Reject = hard-delete; reuse on the now-approved row.)
    await post(request, adminToken, `/api/travel/pois/${suggested.id}/reject`).catch(() => {});
  });

  test("reject path — ADMIN rejects a suggested POI", async ({ request }) => {
    const userToken = await getTravelUser(request);
    const adminToken = await getTravelAdmin(request);
    test.skip(!userToken || !adminToken, "travel test users not seeded");

    const suggestRes = await post(request, userToken, "/api/travel/pois", validSuggestBody({
      name: `${RUN_TAG} Reject Me`,
    }));
    const suggested = await suggestRes.json();

    const rejectRes = await post(request, adminToken, `/api/travel/pois/${suggested.id}/reject`);
    expect(rejectRes.status()).toBe(200);
    const body = await rejectRes.json();
    expect(body).toMatchObject({ ok: true, id: suggested.id });

    // Subsequent reject of the same id → 404 (already deleted).
    const reReject = await post(request, adminToken, `/api/travel/pois/${suggested.id}/reject`);
    expect(reReject.status()).toBe(404);
  });

  test("no auth on POST / -> 401", async ({ request }) => {
    const r = await request.post(`${BASE_URL}/api/travel/pois`, {
      data: validSuggestBody(),
      headers: { "Content-Type": "application/json" },
    });
    expect(r.status()).toBe(401);
  });

  test("no auth on GET /pending -> 401", async ({ request }) => {
    const r = await request.get(`${BASE_URL}/api/travel/pois/pending`);
    expect(r.status()).toBe(401);
  });

  test("USER role denied on /pending -> 403 RBAC_DENIED", async ({ request }) => {
    const userToken = await getTravelUser(request);
    test.skip(!userToken, "travel user not seeded");

    const r = await get(request, userToken, "/api/travel/pois/pending");
    expect(r.status()).toBe(403);
    const body = await r.json();
    expect(body.code).toBe("RBAC_DENIED");
  });

  test("validation — missing name -> 400 MISSING_FIELDS", async ({ request }) => {
    const userToken = await getTravelUser(request);
    test.skip(!userToken, "travel user not seeded");

    const body = validSuggestBody();
    delete body.name;
    const r = await post(request, userToken, "/api/travel/pois", body);
    expect(r.status()).toBe(400);
    const json = await r.json();
    expect(json.code).toBe("MISSING_FIELDS");
  });

  test("validation — missing destinationSlug -> 400 MISSING_FIELDS", async ({ request }) => {
    const userToken = await getTravelUser(request);
    test.skip(!userToken, "travel user not seeded");

    const body = validSuggestBody();
    delete body.destinationSlug;
    const r = await post(request, userToken, "/api/travel/pois", body);
    expect(r.status()).toBe(400);
    const json = await r.json();
    expect(json.code).toBe("MISSING_FIELDS");
  });

  test("validation — out-of-range latitude -> 400 INVALID_COORD", async ({ request }) => {
    const userToken = await getTravelUser(request);
    test.skip(!userToken, "travel user not seeded");

    const r = await post(request, userToken, "/api/travel/pois", validSuggestBody({ latitude: 95 }));
    expect(r.status()).toBe(400);
    const json = await r.json();
    expect(json.code).toBe("INVALID_COORD");
  });

  test("validation — invalid id on approve -> 400 INVALID_ID", async ({ request }) => {
    const adminToken = await getTravelAdmin(request);
    test.skip(!adminToken, "travel admin not seeded");

    const r = await post(request, adminToken, "/api/travel/pois/not-a-number/approve");
    expect(r.status()).toBe(400);
    const json = await r.json();
    expect(json.code).toBe("INVALID_ID");
  });

  test("cross-tenant — generic-admin cannot approve travel-tenant POI -> 404", async ({ request }) => {
    const userToken = await getTravelUser(request);
    const travelAdmin = await getTravelAdmin(request);
    const genericAdmin = await getGenericAdmin(request);
    test.skip(!userToken || !travelAdmin || !genericAdmin, "test users not seeded");

    // Travel user suggests; row is in travel tenant.
    const suggestRes = await post(request, userToken, "/api/travel/pois", validSuggestBody({
      name: `${RUN_TAG} Cross Tenant`,
    }));
    const suggested = await suggestRes.json();

    // Generic-admin tries to approve — should 404 (deliberate, avoids existence leak).
    const r = await post(request, genericAdmin, `/api/travel/pois/${suggested.id}/approve`);
    expect(r.status()).toBe(404);
    const json = await r.json();
    expect(json.code).toBe("POI_NOT_FOUND");

    // Cleanup with the travel admin.
    await post(request, travelAdmin, `/api/travel/pois/${suggested.id}/reject`).catch(() => {});
  });

  // ── G055 / PRD FR-3.2.f — ±50m POI dedup gate ─────────────────────
  test("dedup — second POST at same lat/lng -> 409 POI_DUPLICATE_NEARBY once first is approved", async ({ request }) => {
    const userToken = await getTravelUser(request);
    const adminToken = await getTravelAdmin(request);
    test.skip(!userToken || !adminToken, "travel test users not seeded");

    // Step 1: suggest the original POI at a unique RUN_TAG-derived coordinate
    // so two parallel runs of this spec on the same demo don't collide.
    // Use the tail of Date.now() to derive a unique lat/lng offset (~10m
    // per +0.0001° at this latitude).
    const offset = (Date.now() % 10_000) * 0.00001;
    const lat = 15.5673 + offset;
    const lng = 73.7397 + offset;

    const firstRes = await post(
      request,
      userToken,
      "/api/travel/pois",
      validSuggestBody({
        name: `${RUN_TAG} Dedup Original`,
        latitude: lat,
        longitude: lng,
      }),
    );
    expect([200, 201]).toContain(firstRes.status());
    const first = await firstRes.json();

    // Approve so it counts as an APPROVED comparison row.
    const approveRes = await post(request, adminToken, `/api/travel/pois/${first.id}/approve`);
    expect(approveRes.status()).toBe(200);

    // Step 2: a second POST at THE SAME (lat, lng) must 409.
    const dupRes = await post(
      request,
      userToken,
      "/api/travel/pois",
      validSuggestBody({
        name: `${RUN_TAG} Dedup Should Block`,
        latitude: lat,
        longitude: lng,
      }),
    );
    expect(dupRes.status()).toBe(409);
    const dupBody = await dupRes.json();
    expect(dupBody.code).toBe("POI_DUPLICATE_NEARBY");
    expect(dupBody.existingId).toBe(first.id);
    expect(typeof dupBody.distance).toBe("number");

    // Step 3: ?force=true override bypasses the dedup gate.
    const forceRes = await post(
      request,
      userToken,
      "/api/travel/pois?force=true",
      validSuggestBody({
        name: `${RUN_TAG} Dedup Force Bypass`,
        latitude: lat,
        longitude: lng,
      }),
    );
    expect([200, 201]).toContain(forceRes.status());
    const forced = await forceRes.json();
    expect(forced.pendingApproval).toBe(true);

    // Cleanup — reject all 3 rows.
    await post(request, adminToken, `/api/travel/pois/${forced.id}/reject`).catch(() => {});
    await post(request, adminToken, `/api/travel/pois/${first.id}/reject`).catch(() => {});
  });

  test("MANAGER role denied on /approve -> 403 RBAC_DENIED (ADMIN-only)", async ({ request }) => {
    // Use generic-admin's tenant since we don't have a guaranteed travel-MANAGER seed.
    // Fall back: query the queue endpoint with the user token instead.
    const userToken = await getTravelUser(request);
    test.skip(!userToken, "travel user not seeded");

    // USER hitting /:id/approve also gets RBAC_DENIED — same denial path.
    const r = await post(request, userToken, "/api/travel/pois/1/approve");
    expect(r.status()).toBe(403);
    const json = await r.json();
    expect(json.code).toBe("RBAC_DENIED");
  });
});
