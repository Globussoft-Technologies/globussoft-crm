// @ts-check
/**
 * Gate spec — travel-vertical Visa Sure RejectionRecoveryProgram endpoints (G107).
 *
 * Pins backend/routes/travel_visa.js extension (PRD_VISA_SURE_PHASE_3 §FR-7):
 *
 *   POST  /api/travel/visa/recovery-programs                   — create program
 *   GET   /api/travel/visa/recovery-programs                   — list (filter by country/active)
 *   GET   /api/travel/visa/recovery-programs/:id               — detail + enrolledCount
 *   PUT   /api/travel/visa/recovery-programs/:id               — update program
 *   POST  /api/travel/visa/applications/:id/enrol-recovery     — enrol / un-enrol
 *
 * Auth gates pinned:
 *   - 401 (or 403) without bearer token (global auth guard)
 *   - 403 USER role — requirePermission('visa', read/write/update)
 *   - 403 WRONG_VERTICAL — generic-vertical ADMIN
 *
 * Happy path pinned:
 *   - POST create returns 201 with the row shape (id, tenantId, name,
 *     destinationCountry, visaType, isActive, ...).
 *   - GET list returns { programs, total, limit, offset }.
 *   - GET detail returns the row + enrolledCount field.
 *   - PUT update returns the row with updated fields.
 *
 * Validation pinned (smoke):
 *   - Missing name on POST → 400 MISSING_FIELDS.
 *   - Out-of-range successRate → 400 INVALID_SUCCESS_RATE.
 *
 * Auth deps: yasin@travelstall.in (travel ADMIN) +
 *            telecaller@travelstall.demo (travel USER) +
 *            admin@globussoft.com (generic ADMIN).
 *
 * Created rows are intentionally NOT torn down at the end — the program
 * has business-side meaning (advisor curated curriculum); demo-hygiene
 * reaps via the RUN_TAG suffix per the existing pattern.
 */

const { test, expect } = require("@playwright/test");

test.describe.configure({ mode: "serial" });

const BASE_URL = process.env.BASE_URL || "https://crm.globusdemos.com";
const REQUEST_TIMEOUT = 60000;
const RUN_TAG = `_teardown_g107_${Date.now()}`;

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

const headers = (token) => ({
  Authorization: `Bearer ${token}`,
  "Content-Type": "application/json",
});

let createdProgramId = null;

test.describe("travel-visa recovery-programs — auth + role gates", () => {
  test("no auth → 401/403", async ({ request }) => {
    const r = await request.get(`${BASE_URL}/api/travel/visa/recovery-programs`);
    expect([401, 403]).toContain(r.status());
  });

  test("USER role → 403", async ({ request }) => {
    const tok = await getTravelUser(request);
    test.skip(!tok, "travel USER seed missing");
    const r = await request.get(`${BASE_URL}/api/travel/visa/recovery-programs`, {
      headers: headers(tok),
    });
    expect(r.status()).toBe(403);
  });

  test("generic-vertical ADMIN → 403 WRONG_VERTICAL", async ({ request }) => {
    const tok = await getGenericAdmin(request);
    test.skip(!tok, "generic ADMIN seed missing");
    const r = await request.get(`${BASE_URL}/api/travel/visa/recovery-programs`, {
      headers: headers(tok),
    });
    expect(r.status()).toBe(403);
  });
});

test.describe("travel-visa recovery-programs — happy path", () => {
  test("POST create returns 201 with the row shape", async ({ request }) => {
    const tok = await getTravelAdmin(request);
    test.skip(!tok, "travel ADMIN seed missing");
    const r = await request.post(`${BASE_URL}/api/travel/visa/recovery-programs`, {
      headers: headers(tok),
      data: {
        name: `USA B1/B2 recovery program${RUN_TAG}`,
        destinationCountry: "US",
        visaType: "tourist",
        description: "Second-attempt program for refused B1/B2 applicants",
        durationDays: 45,
        successRate: 65,
        feeAmount: 5000,
        feeCurrency: "USD",
      },
      timeout: REQUEST_TIMEOUT,
    });
    expect(r.status()).toBe(201);
    const body = await r.json();
    expect(body.id).toBeGreaterThan(0);
    expect(body.name).toContain(RUN_TAG);
    expect(body.destinationCountry).toBe("US");
    expect(body.isActive).toBe(true);
    createdProgramId = body.id;
  });

  test("GET list returns paginated envelope", async ({ request }) => {
    const tok = await getTravelAdmin(request);
    test.skip(!tok, "travel ADMIN seed missing");
    const r = await request.get(`${BASE_URL}/api/travel/visa/recovery-programs?country=US`, {
      headers: headers(tok),
    });
    expect(r.status()).toBe(200);
    const body = await r.json();
    expect(Array.isArray(body.programs)).toBe(true);
    expect(typeof body.total).toBe("number");
    expect(typeof body.limit).toBe("number");
    expect(typeof body.offset).toBe("number");
  });

  test("GET detail returns enrolledCount", async ({ request }) => {
    const tok = await getTravelAdmin(request);
    test.skip(!tok || !createdProgramId, "needs created program");
    const r = await request.get(
      `${BASE_URL}/api/travel/visa/recovery-programs/${createdProgramId}`,
      { headers: headers(tok) },
    );
    expect(r.status()).toBe(200);
    const body = await r.json();
    expect(body.id).toBe(createdProgramId);
    expect(typeof body.enrolledCount).toBe("number");
  });

  test("PUT update applies the new values", async ({ request }) => {
    const tok = await getTravelAdmin(request);
    test.skip(!tok || !createdProgramId, "needs created program");
    const r = await request.put(
      `${BASE_URL}/api/travel/visa/recovery-programs/${createdProgramId}`,
      {
        headers: headers(tok),
        data: { description: "Updated copy — coaching + mock-interview rounds" },
      },
    );
    expect(r.status()).toBe(200);
    const body = await r.json();
    expect(body.description).toContain("Updated copy");
  });
});

test.describe("travel-visa recovery-programs — validation", () => {
  test("POST missing name → 400 MISSING_FIELDS", async ({ request }) => {
    const tok = await getTravelAdmin(request);
    test.skip(!tok, "travel ADMIN seed missing");
    const r = await request.post(`${BASE_URL}/api/travel/visa/recovery-programs`, {
      headers: headers(tok),
      data: { destinationCountry: "US" },
    });
    expect(r.status()).toBe(400);
    const body = await r.json();
    expect(body.code).toBe("MISSING_FIELDS");
  });

  test("POST out-of-range successRate → 400 INVALID_SUCCESS_RATE", async ({ request }) => {
    const tok = await getTravelAdmin(request);
    test.skip(!tok, "travel ADMIN seed missing");
    const r = await request.post(`${BASE_URL}/api/travel/visa/recovery-programs`, {
      headers: headers(tok),
      data: { name: "X" + RUN_TAG, destinationCountry: "US", successRate: 150 },
    });
    expect(r.status()).toBe(400);
    const body = await r.json();
    expect(body.code).toBe("INVALID_SUCCESS_RATE");
  });

  test("GET detail with non-numeric id → 400 INVALID_ID", async ({ request }) => {
    const tok = await getTravelAdmin(request);
    test.skip(!tok, "travel ADMIN seed missing");
    const r = await request.get(`${BASE_URL}/api/travel/visa/recovery-programs/abc`, {
      headers: headers(tok),
    });
    expect(r.status()).toBe(400);
  });

  test("GET detail with unknown id → 404 PROGRAM_NOT_FOUND", async ({ request }) => {
    const tok = await getTravelAdmin(request);
    test.skip(!tok, "travel ADMIN seed missing");
    const r = await request.get(`${BASE_URL}/api/travel/visa/recovery-programs/999999`, {
      headers: headers(tok),
    });
    expect(r.status()).toBe(404);
    const body = await r.json();
    expect(body.code).toBe("PROGRAM_NOT_FOUND");
  });
});

test.describe("travel-visa enrol-recovery — validation gates", () => {
  test("non-numeric application id → 400 INVALID_ID", async ({ request }) => {
    const tok = await getTravelAdmin(request);
    test.skip(!tok, "travel ADMIN seed missing");
    const r = await request.post(
      `${BASE_URL}/api/travel/visa/applications/abc/enrol-recovery`,
      {
        headers: headers(tok),
        data: { recoveryProgramId: createdProgramId || 1 },
      },
    );
    expect(r.status()).toBe(400);
  });

  test("unknown application id → 404 APPLICATION_NOT_FOUND", async ({ request }) => {
    const tok = await getTravelAdmin(request);
    test.skip(!tok || !createdProgramId, "needs ADMIN + created program");
    const r = await request.post(
      `${BASE_URL}/api/travel/visa/applications/999999/enrol-recovery`,
      {
        headers: headers(tok),
        data: { recoveryProgramId: createdProgramId },
      },
    );
    expect(r.status()).toBe(404);
    const body = await r.json();
    expect(body.code).toBe("APPLICATION_NOT_FOUND");
  });
});
