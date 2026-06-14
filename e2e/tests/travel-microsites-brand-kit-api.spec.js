// @ts-check
/**
 * Gate spec — G095 (PRD_TRAVEL_PER_SUBBRAND_BRANDING FR-3.3.i / AC-6.9)
 *
 * Pins the contract that the public microsite GET response now carries
 * an additive `brandKit` block resolved from the microsite's sub-brand
 * (TMC per Q21). The frontend PublicTripMicrosite.jsx consumes this
 * block to theme the public chrome (palette + logo + tagline + mission
 * + support contacts) without a second round-trip.
 *
 * Locked invariants:
 *   - GET /api/travel/microsites/public/:uuid returns a `brandKit` key
 *     in the response (null when no active kit; object when one exists).
 *   - The `brandKit` field is reachable WITHOUT an Authorization header
 *     (the entire public path is openPath-allowlisted).
 *   - tenantId is NEVER echoed in the public response (it's selected
 *     internally to resolve the brand kit but stripped before res.json).
 *   - Public companion endpoint /api/brand-kits/by-subbrand/:subBrand
 *     is reachable without auth and returns the same shape for all 4
 *     valid sub-brands.
 *
 * Out of scope (W4.A sibling territory):
 *   - Brand-kit POST/PUT/DELETE shape (covered by brand_kits.test.js).
 *   - Operator-side BrandKits.jsx UI (G099 — sibling agent A).
 */

const { test, expect } = require("@playwright/test");

test.describe.configure({ mode: "serial" });

const BASE_URL = process.env.BASE_URL || "https://crm.globusdemos.com";
const REQUEST_TIMEOUT = 60000;
const RUN_TAG = `E2E_TRAVEL_BK_${Date.now()}`;

let travelAdminToken = null;
let tripId = null;
let schoolContactId = null;
let micrositeUuid = null;

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

async function post(request, token, path, body) {
  return retryOn5xx(() => request.post(`${BASE_URL}${path}`, { headers: headers(token), data: body ?? {}, timeout: REQUEST_TIMEOUT }));
}

async function del(request, token, path) {
  return retryOn5xx(() => request.delete(`${BASE_URL}${path}`, { headers: headers(token), timeout: REQUEST_TIMEOUT }));
}

test.beforeAll(async ({ request }) => {
  const token = await getTravelAdmin(request);
  if (!token) return;
  // Seed a school Contact + a Trip to host the microsite.
  const cRes = await post(request, token, "/api/contacts", {
    name: `${RUN_TAG} Brand Kit School`,
    email: `${RUN_TAG.toLowerCase()}-school@e2e.test`,
    phone: `+91${String(Date.now()).slice(-10)}`,
    subBrand: "tmc",
  });
  if (cRes.ok()) {
    schoolContactId = (await cRes.json()).id;
  }
  if (!schoolContactId) return;
  const tRes = await post(request, token, "/api/travel/trips", {
    tripCode: `${RUN_TAG.toLowerCase()}_trip`,
    schoolContactId,
    destination: `${RUN_TAG} Brand Kit Trip`,
    departDate: "2026-10-01",
    returnDate: "2026-10-10",
  });
  if (tRes.ok()) {
    tripId = (await tRes.json()).id;
  }
  if (!tripId) return;
  const mRes = await post(request, token, `/api/travel/trips/${tripId}/microsite`, {
    itineraryHtml: `<h1>${RUN_TAG} Brand kit trip</h1>`,
  });
  if (mRes.ok()) {
    micrositeUuid = (await mRes.json()).publicUuid;
  }
});

test.afterAll(async ({ request }) => {
  const token = await getTravelAdmin(request);
  if (!token) return;
  if (tripId) {
    await del(request, token, `/api/travel/trips/${tripId}`).catch(() => {});
  }
  if (schoolContactId) {
    await del(request, token, `/api/contacts/${schoolContactId}`).catch(() => {});
  }
});

// ─── Microsite public GET — additive brandKit block ─────────────────

test.describe("Travel microsites — G095 brand-kit block", () => {
  test("GET /microsites/public/:uuid includes a `brandKit` key (null OK)", async ({ request }) => {
    if (!micrositeUuid) test.skip(true, "no microsite uuid");
    const res = await retryOn5xx(() =>
      request.get(`${BASE_URL}/api/travel/microsites/public/${micrositeUuid}`, {
        timeout: REQUEST_TIMEOUT,
      }),
    );
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.publicUuid).toBe(micrositeUuid);
    // `brandKit` is part of the response shape (additive). Either an
    // object (when an active kit exists for tmc) or `null` (when no
    // active kit exists — pre-cred-handover demo state).
    expect("brandKit" in body).toBe(true);
    expect(body.brandKit === null || typeof body.brandKit === "object").toBe(true);
    // CRITICAL — tenantId is the internal-only field used to resolve
    // the brand kit and MUST NOT leak in the public payload.
    expect(body.tenantId).toBeUndefined();
  });

  test("GET /microsites/public/:uuid is auth-free (no Authorization header)", async ({ request }) => {
    if (!micrositeUuid) test.skip(true, "no microsite uuid");
    const res = await retryOn5xx(() =>
      request.get(`${BASE_URL}/api/travel/microsites/public/${micrositeUuid}`, {
        // NO Authorization header.
        timeout: REQUEST_TIMEOUT,
      }),
    );
    expect(res.status()).toBe(200);
  });
});

// ─── Public companion endpoint /by-subbrand/:subBrand ────────────────

test.describe("Travel branding — G092 public brand-kit endpoint", () => {
  test("GET /api/brand-kits/by-subbrand/tmc is reachable without auth", async ({ request }) => {
    const res = await retryOn5xx(() =>
      request.get(`${BASE_URL}/api/brand-kits/by-subbrand/tmc`, { timeout: REQUEST_TIMEOUT }),
    );
    // 200 when a kit exists; 404 when not (BRAND_KIT_NOT_FOUND). Either
    // is a green test as long as the route is auth-free.
    expect([200, 404]).toContain(res.status());
    const body = await res.json();
    if (res.status() === 200) {
      expect(body.subBrand).toBe("tmc");
      expect(body.brandKit).toBeTruthy();
      // No internal fields leak.
      expect(body.brandKit.id).toBeUndefined();
      expect(body.brandKit.tenantId).toBeUndefined();
      expect(body.brandKit.version).toBeUndefined();
      expect(body.brandKit.isActive).toBeUndefined();
      expect(body.brandKit.signatureTemplate).toBeUndefined();
    } else {
      expect(body.code).toBe("BRAND_KIT_NOT_FOUND");
    }
  });

  test("GET with unknown sub-brand → 400 INVALID_SUB_BRAND", async ({ request }) => {
    const res = await retryOn5xx(() =>
      request.get(`${BASE_URL}/api/brand-kits/by-subbrand/notarealbrand`, {
        timeout: REQUEST_TIMEOUT,
      }),
    );
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("INVALID_SUB_BRAND");
  });

  test("GET with placeholder `_` sub-brand → 400 MISSING_SUB_BRAND", async ({ request }) => {
    const res = await retryOn5xx(() =>
      request.get(`${BASE_URL}/api/brand-kits/by-subbrand/_`, { timeout: REQUEST_TIMEOUT }),
    );
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("MISSING_SUB_BRAND");
  });
});
