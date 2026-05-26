// @ts-check
/**
 * Gate spec — Travel Stall personalised 3-5 destination PDF endpoint.
 *
 * Pins POST /api/travel/travelstall/personalised-pdf/regen — the 4th
 * LLM-router consumer (after talking-points, form-vs-call, itinerary
 * draft/regen). Phase 2 row TS18 from TRAVEL_CRM_PORTAL_FEATURE_MATRIX.md.
 *
 * Endpoint shape:
 *   - Auth: verifyToken + verifyRole(["ADMIN", "MANAGER"]) + requireTravelTenant
 *   - Body: { contactId, destinations?, budget?, durationDays? }
 *   - Returns { pdfUrl, generatedAt, model, stub } envelope
 *   - PDF returned as base64-encoded data: URL (Phase 2 — transient,
 *     blob-store wiring lands with Q22 brand assets)
 *
 * STUB mode today:
 *   - Q11 LLM keys NOT in CI → router returns deterministic
 *     [STUB-BULK-TEXT] prose with stub:true and model:"gemini-flash"
 *     (PRD §9.1 — bulk-text task class)
 *   - Q22 brand assets NOT here → PDF template uses placeholder branding
 *
 * Auth deps: yasin@travelstall.in (travel ADMIN, seeded by seed-travel.js)
 * + admin@globussoft.com (generic ADMIN, in seed.js).
 *
 * Contact dep: we create a tagged Contact in beforeAll + clean up afterAll.
 */

const { test, expect } = require("@playwright/test");

test.describe.configure({ mode: "serial" });

const BASE_URL = process.env.BASE_URL || "https://crm.globusdemos.com";
const REQUEST_TIMEOUT = 60000;
const RUN_TAG = `E2E_TRAVELSTALL_PDF_${Date.now()}`;

let travelAdminToken = null;
let travelUserToken = null;
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

async function post(request, token, path, body) {
  return retryOn5xx(() =>
    request.post(`${BASE_URL}${path}`, {
      headers: headers(token),
      data: body ?? {},
      timeout: REQUEST_TIMEOUT,
    }),
  );
}

async function del(request, token, path) {
  return retryOn5xx(() =>
    request.delete(`${BASE_URL}${path}`, { headers: headers(token), timeout: REQUEST_TIMEOUT }),
  );
}

const ENDPOINT = "/api/travel/travelstall/personalised-pdf/regen";

test.beforeAll(async ({ request }) => {
  const token = await getTravelAdmin(request);
  if (!token) return;
  // Mint a Contact owned by the travel tenant — tagged so demo-scrub can sweep.
  const r = await post(request, token, "/api/contacts", {
    name: `${RUN_TAG} Travel Stall Test Contact`,
    email: `${RUN_TAG.toLowerCase()}@e2e.test`,
    phone: `+91${String(Date.now()).slice(-10)}`,
    subBrand: "travelstall",
  });
  if (r.ok()) {
    const body = await r.json();
    testContactId = body.id || body.contact?.id;
  }
});

test.afterAll(async ({ request }) => {
  const token = await getTravelAdmin(request);
  if (!token) return;
  if (testContactId) {
    await del(request, token, `/api/contacts/${testContactId}`).catch(() => {});
  }
});

// ─── Auth gates ──────────────────────────────────────────────────────

test.describe("Travel Stall personalised-PDF — auth gates", () => {
  test("POST without auth → 401/403", async ({ request }) => {
    const res = await request.post(`${BASE_URL}${ENDPOINT}`, {
      headers: { "Content-Type": "application/json" },
      data: { contactId: 1 },
      timeout: REQUEST_TIMEOUT,
    });
    expect([401, 403]).toContain(res.status());
  });

  test("POST as USER role → 403 RBAC_DENIED (ADMIN/MANAGER only)", async ({ request }) => {
    const token = await getTravelUser(request);
    if (!token) test.skip(true, "telecaller@travelstall.demo not seeded");
    if (!testContactId) test.skip(true, "test contact not created in beforeAll");
    const res = await post(request, token, ENDPOINT, { contactId: testContactId });
    expect(res.status()).toBe(403);
    const body = await res.json();
    expect(body.code).toBe("RBAC_DENIED");
  });

  test("POST from generic-vertical admin → 403 WRONG_VERTICAL", async ({ request }) => {
    // requireTravelTenant rejects FIRST — a non-travel ADMIN cannot reach
    // this endpoint regardless of body.
    const token = await getGenericAdmin(request);
    if (!token) test.skip(true, "admin@globussoft.com not seeded");
    const res = await post(request, token, ENDPOINT, { contactId: 1 });
    expect(res.status()).toBe(403);
    const body = await res.json();
    expect(body.code).toBe("WRONG_VERTICAL");
  });
});

// ─── Body validation ─────────────────────────────────────────────────

test.describe("Travel Stall personalised-PDF — body validation", () => {
  test("POST without contactId → 400 INVALID_CONTACT_ID", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token) test.skip(true, "travel admin not available");
    const res = await post(request, token, ENDPOINT, {});
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("INVALID_CONTACT_ID");
  });

  test("POST with non-numeric contactId → 400 INVALID_CONTACT_ID", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token) test.skip(true, "travel admin not available");
    const res = await post(request, token, ENDPOINT, { contactId: "abc" });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("INVALID_CONTACT_ID");
  });

  test("POST with unknown contactId → 404 CONTACT_NOT_FOUND", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token) test.skip(true, "travel admin not available");
    const res = await post(request, token, ENDPOINT, { contactId: 9999999 });
    expect(res.status()).toBe(404);
    const body = await res.json();
    expect(body.code).toBe("CONTACT_NOT_FOUND");
  });

  test("POST with non-array destinations → 400 INVALID_DESTINATIONS", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token || !testContactId) test.skip(true, "seed missing");
    const res = await post(request, token, ENDPOINT, {
      contactId: testContactId,
      destinations: "Goa",
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("INVALID_DESTINATIONS");
  });

  test("POST with negative budget → 400 INVALID_BUDGET", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token || !testContactId) test.skip(true, "seed missing");
    const res = await post(request, token, ENDPOINT, {
      contactId: testContactId,
      budget: -100,
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("INVALID_BUDGET");
  });

  test("POST with zero durationDays → 400 INVALID_DURATION", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token || !testContactId) test.skip(true, "seed missing");
    const res = await post(request, token, ENDPOINT, {
      contactId: testContactId,
      durationDays: 0,
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("INVALID_DURATION");
  });
});

// ─── Happy path + stub envelope ──────────────────────────────────────

test.describe("Travel Stall personalised-PDF — happy path", () => {
  test("POST with valid body → 201 + stub envelope + valid PDF data URL", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token || !testContactId) test.skip(true, "seed missing");
    const res = await post(request, token, ENDPOINT, {
      contactId: testContactId,
      destinations: ["Goa", "Kerala", "Andaman"],
      budget: 150000,
      durationDays: 7,
    });
    expect(res.status(), `regen: ${await res.text()}`).toBe(201);
    const body = await res.json();
    // PRD §9.1 — bulk-text task routes to Gemini Flash primary.
    expect(body.model).toBe("gemini-flash");
    // CI runs without LLM API keys → stub mode.
    expect(body.stub).toBe(true);
    // generatedAt must parse back to a valid Date.
    expect(Number.isFinite(Date.parse(body.generatedAt))).toBe(true);
    // pdfUrl must be a data: URL with PDF magic bytes after the base64 prefix.
    expect(typeof body.pdfUrl).toBe("string");
    expect(body.pdfUrl.startsWith("data:application/pdf;base64,")).toBe(true);
    const base64Part = body.pdfUrl.slice("data:application/pdf;base64,".length);
    expect(base64Part.length).toBeGreaterThan(100); // non-empty PDF
    const pdfBuffer = Buffer.from(base64Part, "base64");
    // PDF magic bytes 0x25 0x50 0x44 0x46 (%PDF)
    expect(pdfBuffer[0]).toBe(0x25);
    expect(pdfBuffer[1]).toBe(0x50);
    expect(pdfBuffer[2]).toBe(0x44);
    expect(pdfBuffer[3]).toBe(0x46);
  });

  test("POST without optional fields → 201 (destinations/budget/duration all optional)", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token || !testContactId) test.skip(true, "seed missing");
    const res = await post(request, token, ENDPOINT, {
      contactId: testContactId,
    });
    expect(res.status(), `regen-min: ${await res.text()}`).toBe(201);
    const body = await res.json();
    expect(body.stub).toBe(true);
    expect(body.model).toBe("gemini-flash");
    expect(typeof body.pdfUrl).toBe("string");
  });

  test("POST with 5 destinations → 201 (5-card upper bound visibility)", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token || !testContactId) test.skip(true, "seed missing");
    const res = await post(request, token, ENDPOINT, {
      contactId: testContactId,
      destinations: ["Goa", "Kerala", "Andaman", "Sikkim", "Rajasthan"],
    });
    expect(res.status()).toBe(201);
    const body = await res.json();
    expect(body.stub).toBe(true);
    const pdfBuffer = Buffer.from(
      body.pdfUrl.slice("data:application/pdf;base64,".length),
      "base64",
    );
    expect(pdfBuffer[0]).toBe(0x25); // %
    expect(pdfBuffer[1]).toBe(0x50); // P
  });
});
