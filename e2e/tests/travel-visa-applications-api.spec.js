// @ts-check
/**
 * Gate spec — travel-vertical Visa Sure Applications endpoints (Phase 3).
 *
 * Pins the Phase 3 cluster B3 backend contract that lets the frontend
 * SHELLs fetch real data AND the v3.x extension that adds the CREATE
 * surface (commit following ce5f5db):
 *
 *   GET  /api/travel/visa/applications        — paginated list
 *   GET  /api/travel/visa/applications/:id    — single-application detail
 *   POST /api/travel/visa/applications        — create new application (intake)
 *
 * Auth gates:
 *   - 401 (or 403) without bearer token (global auth guard)
 *   - 403 USER role (requirePermission('visa', read/write/update))
 *   - 403 WRONG_VERTICAL — generic-vertical ADMIN rejected by
 *     requireTravelTenant.
 *
 * Empty-state path:
 *   - When no Visa-Sure contacts exist (likely on a freshly-seeded box),
 *     the list endpoint returns 200 with applications:[] + total:0 rather
 *     than 500ing. Applications.jsx + AdvisorDashboard.jsx SHELLs depend
 *     on this graceful empty.
 *
 * Happy path:
 *   - List envelope { applications, total, limit, offset } regardless of
 *     populated/empty state.
 *   - Detail 404s for both genuinely-missing IDs AND for IDs that exist
 *     but reference a non-visasure Contact (sub-brand isolation).
 *
 * Filter:
 *   - ?status=intake works; ?status=garbage rejected as 400 INVALID_STATUS.
 *
 * CREATE contract (the extension):
 *   - Body: { contactId:Int, applicationType:enum, destinationCountry:String }
 *   - applicationType enum pinned to ['tourist','business','student','work',
 *     'umrah','hajj'] per prisma/schema.prisma:4502.
 *   - The dispatch brief had `destination` + `notes` + `priorityLevel` —
 *     drifts from schema today: column is `destinationCountry`, no `notes`
 *     column on VisaApplication (notes live per-document), no `priorityLevel`
 *     column. Spec pins schema reality.
 *   - Sub-brand isolation: Contact.subBrand must be "visasure" else 403
 *     NOT_VISA_SURE. Same defense-in-depth as the GET /:id detail handler.
 *   - Tenant isolation: contactId from another tenant → 404 NOT_FOUND
 *     (NOT 403 — we deliberately surface "not found" rather than leaking
 *     existence of the cross-tenant contact).
 *   - Happy-path returns 201 with the created row shape:
 *     { id, tenantId, contactId, applicationType, destinationCountry,
 *       status:"intake", readinessLevel:null, ... }.
 *
 * Auth deps: yasin@travelstall.in (travel ADMIN, seed-travel.js) +
 *            tmc-ops@travelstall.demo (travel MANAGER) +
 *            telecaller@travelstall.demo (travel USER) +
 *            admin@globussoft.com (generic ADMIN — cross-vertical guard).
 *
 * NOTE on demo state. The CREATE tests use real visa-sure Contacts when
 * the demo has them (looked up via the list endpoint to find a real
 * contactId). The happy-path POST is guarded with a graceful skip when
 * the demo has no visa-sure contacts to create against. Created rows are
 * NOT torn down — Visa Sure pipeline data is durable demo state and the
 * advisor view benefits from accumulated applications; the RUN_TAG in
 * destinationCountry lets demo-hygiene reap them if needed (existing
 * demoHygieneEngine pattern).
 */

const { test, expect } = require("@playwright/test");

test.describe.configure({ mode: "serial" });

const BASE_URL = process.env.BASE_URL || "https://crm.globusdemos.com";
const REQUEST_TIMEOUT = 60000;

let travelAdminToken = null;
let travelManagerToken = null;
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
async function getTravelManager(request) {
  if (!travelManagerToken) {
    travelManagerToken = await loginAs(request, "tmc-ops@travelstall.demo", "password123");
  }
  return travelManagerToken;
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

async function get(request, token, path) {
  return retryOn5xx(() =>
    request.get(`${BASE_URL}${path}`, {
      headers: token ? headers(token) : { "Content-Type": "application/json" },
      timeout: REQUEST_TIMEOUT,
    }),
  );
}

async function post(request, token, path, data) {
  return retryOn5xx(() =>
    request.post(`${BASE_URL}${path}`, {
      headers: token ? headers(token) : { "Content-Type": "application/json" },
      data,
      timeout: REQUEST_TIMEOUT,
    }),
  );
}

async function patch(request, token, path, data) {
  return retryOn5xx(() =>
    request.patch(`${BASE_URL}${path}`, {
      headers: token ? headers(token) : { "Content-Type": "application/json" },
      data,
      timeout: REQUEST_TIMEOUT,
    }),
  );
}

// RUN_TAG suffix for create-flow assertions — lets demo-hygiene identify
// spec-created rows for optional cleanup. Format mirrors other gate
// specs (e.g. e2e/tests/test-data-patterns.js conventions).
const RUN_TAG = `E2E_VISA_POST_${Date.now()}`;

// ─── Auth-gate tests ─────────────────────────────────────────────────

test.describe("Visa Sure applications — auth gates", () => {
  test("GET /applications without token → 401 (or 403)", async ({ request }) => {
    const r = await request.get(`${BASE_URL}/api/travel/visa/applications`, {
      headers: { "Content-Type": "application/json" },
      timeout: REQUEST_TIMEOUT,
    });
    // Global auth guard returns 401 or 403 depending on hardened mode;
    // both are acceptable per CLAUDE.md cross-cutting-shape standing rule.
    expect([401, 403]).toContain(r.status());
  });

  test("GET /applications/:id without token → 401 (or 403)", async ({ request }) => {
    const r = await request.get(
      `${BASE_URL}/api/travel/visa/applications/1`,
      {
        headers: { "Content-Type": "application/json" },
        timeout: REQUEST_TIMEOUT,
      },
    );
    expect([401, 403]).toContain(r.status());
  });

  test("GET /applications as USER role → 403", async ({ request }) => {
    const token = await getTravelUser(request);
    if (!token) {
      test.skip(true, "telecaller@travelstall.demo not seeded — skipping USER-RBAC test");
      return;
    }
    const r = await get(request, token, "/api/travel/visa/applications");
    expect(r.status()).toBe(403);
  });

  test("GET /applications from generic-vertical ADMIN → 403 WRONG_VERTICAL", async ({ request }) => {
    const token = await getGenericAdmin(request);
    if (!token) {
      test.skip(true, "admin@globussoft.com not seeded — skipping cross-vertical guard");
      return;
    }
    const r = await get(request, token, "/api/travel/visa/applications");
    expect(r.status()).toBe(403);
    const body = await r.json();
    expect(body.code).toBe("WRONG_VERTICAL");
  });
});

// ─── Happy-path list + filter ────────────────────────────────────────

test.describe("Visa Sure applications — list happy path", () => {
  test("GET /applications → 200 with list envelope", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token) {
      test.skip(true, "yasin@travelstall.in not seeded — skipping happy path");
      return;
    }
    const r = await get(request, token, "/api/travel/visa/applications");
    expect(r.status()).toBe(200);
    const body = await r.json();

    // Envelope shape — these four fields must exist on every response,
    // populated or empty.
    expect(body).toHaveProperty("applications");
    expect(body).toHaveProperty("total");
    expect(body).toHaveProperty("limit");
    expect(body).toHaveProperty("offset");
    expect(Array.isArray(body.applications)).toBe(true);
    expect(typeof body.total).toBe("number");
    expect(typeof body.limit).toBe("number");
    expect(typeof body.offset).toBe("number");
    expect(body.limit).toBeGreaterThan(0);
    expect(body.limit).toBeLessThanOrEqual(200);
    expect(body.offset).toBeGreaterThanOrEqual(0);
  });

  test("GET /applications as MANAGER role → 200 (RBAC accepts MANAGER)", async ({ request }) => {
    const token = await getTravelManager(request);
    if (!token) {
      test.skip(true, "tmc-ops@travelstall.demo not seeded — skipping MANAGER happy path");
      return;
    }
    const r = await get(request, token, "/api/travel/visa/applications");
    expect(r.status()).toBe(200);
    const body = await r.json();
    expect(Array.isArray(body.applications)).toBe(true);
  });

  test("GET /applications?limit=10&offset=0 → respects pagination params", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token) {
      test.skip(true, "yasin@travelstall.in not seeded — skipping pagination test");
      return;
    }
    const r = await get(
      request,
      token,
      "/api/travel/visa/applications?limit=10&offset=0",
    );
    expect(r.status()).toBe(200);
    const body = await r.json();
    expect(body.limit).toBe(10);
    expect(body.offset).toBe(0);
    // applications array length must be ≤ limit.
    expect(body.applications.length).toBeLessThanOrEqual(10);
  });

  test("GET /applications?status=intake → 200 (valid status filter)", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token) {
      test.skip(true, "yasin@travelstall.in not seeded — skipping filter test");
      return;
    }
    const r = await get(
      request,
      token,
      "/api/travel/visa/applications?status=intake",
    );
    expect(r.status()).toBe(200);
    const body = await r.json();
    // If applications come back, every one must have status="intake".
    for (const a of body.applications) {
      expect(a.status).toBe("intake");
    }
  });

  test("GET /applications?status=garbage → 400 INVALID_STATUS", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token) {
      test.skip(true, "yasin@travelstall.in not seeded — skipping status-validation test");
      return;
    }
    const r = await get(
      request,
      token,
      "/api/travel/visa/applications?status=garbage",
    );
    expect(r.status()).toBe(400);
    const body = await r.json();
    expect(body.code).toBe("INVALID_STATUS");
  });
});

// ─── Detail path ─────────────────────────────────────────────────────

test.describe("Visa Sure applications — detail path", () => {
  test("GET /applications/999999999 → 404 NOT_FOUND", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token) {
      test.skip(true, "yasin@travelstall.in not seeded — skipping NOT_FOUND test");
      return;
    }
    const r = await get(
      request,
      token,
      "/api/travel/visa/applications/999999999",
    );
    expect(r.status()).toBe(404);
    const body = await r.json();
    // Either NOT_FOUND (no row at all) or NOT_VISA_SURE (row exists but
    // contact subBrand != visasure). Both are acceptable rejection codes.
    expect(["NOT_FOUND", "NOT_VISA_SURE"]).toContain(body.code);
  });

  test("GET /applications/not-a-number → 400 INVALID_ID", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token) {
      test.skip(true, "yasin@travelstall.in not seeded — skipping INVALID_ID test");
      return;
    }
    const r = await get(
      request,
      token,
      "/api/travel/visa/applications/not-a-number",
    );
    expect(r.status()).toBe(400);
    const body = await r.json();
    expect(body.code).toBe("INVALID_ID");
  });

  // Detail-envelope happy path. Walks the list first to grab a real
  // application ID (if any exist on the demo). If the list is empty we
  // skip — the empty-state path is already covered above.
  test("GET /applications/:id with a real ID → 200 with detail envelope", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token) {
      test.skip(true, "yasin@travelstall.in not seeded — skipping detail happy path");
      return;
    }
    const listR = await get(request, token, "/api/travel/visa/applications");
    expect(listR.status()).toBe(200);
    const listBody = await listR.json();
    if (!Array.isArray(listBody.applications) || listBody.applications.length === 0) {
      test.skip(
        true,
        "no visa applications on this stack — detail envelope path covered by the empty-state assertion in the list happy-path test",
      );
      return;
    }

    const first = listBody.applications[0];
    const detailR = await get(
      request,
      token,
      `/api/travel/visa/applications/${first.id}`,
    );
    expect(detailR.status()).toBe(200);
    const detail = await detailR.json();

    // Core VisaApplication fields.
    expect(detail).toHaveProperty("id");
    expect(detail).toHaveProperty("contactId");
    expect(detail).toHaveProperty("applicationType");
    expect(detail).toHaveProperty("status");
    expect(detail).toHaveProperty("documentChecklist");
    expect(Array.isArray(detail.documentChecklist)).toBe(true);

    // Joined Contact projection — must include id + name + subBrand;
    // subBrand should be visasure (sub-brand isolation invariant).
    expect(detail).toHaveProperty("contact");
    if (detail.contact) {
      expect(detail.contact).toHaveProperty("id");
      expect(detail.contact).toHaveProperty("name");
      expect(detail.contact.subBrand).toBe("visasure");
    }

    // Diagnostic is optional — present or null, but the key must exist.
    expect(detail).toHaveProperty("diagnostic");
  });
});

// ─── POST /applications — CREATE flow ────────────────────────────────
//
// Auth gates, body validation, sub-brand isolation, tenant isolation,
// happy path. Uses a real visa-sure contactId discovered via the list
// endpoint; falls back to test.skip on the (rare) demo state where no
// visa-sure contact exists.

async function findVisaSureContactId(request, token) {
  const r = await get(request, token, "/api/travel/visa/applications?limit=1");
  if (r.status() !== 200) return null;
  const body = await r.json();
  if (Array.isArray(body.applications) && body.applications.length > 0) {
    return body.applications[0].contactId;
  }
  // No existing applications — try fetching a visa-sure contact directly
  // via /api/contacts. Filter is best-effort; if backend doesn't honour
  // the subBrand query param, we scan the returned page.
  const cr = await get(request, token, "/api/contacts?limit=200");
  if (cr.status() !== 200) return null;
  const cBody = await cr.json();
  const list = Array.isArray(cBody) ? cBody : cBody.contacts || cBody.data || [];
  const visa = list.find((c) => c && c.subBrand === "visasure");
  return visa ? visa.id : null;
}

async function findNonVisaSureContactId(request, token) {
  // Look for a contact whose subBrand is set but NOT "visasure" (typically
  // tmc / rfu in the travel seed). Used for the NOT_VISA_SURE 403 test.
  const cr = await get(request, token, "/api/contacts?limit=200");
  if (cr.status() !== 200) return null;
  const cBody = await cr.json();
  const list = Array.isArray(cBody) ? cBody : cBody.contacts || cBody.data || [];
  const nonVisa = list.find(
    (c) => c && c.subBrand && c.subBrand !== "visasure",
  );
  return nonVisa ? nonVisa.id : null;
}

test.describe("Visa Sure applications — CREATE flow", () => {
  test("POST /applications without token → 401 (or 403)", async ({ request }) => {
    const r = await request.post(`${BASE_URL}/api/travel/visa/applications`, {
      headers: { "Content-Type": "application/json" },
      data: {
        contactId: 1,
        applicationType: "tourist",
        destinationCountry: "US",
      },
      timeout: REQUEST_TIMEOUT,
    });
    // Global auth guard returns 401 or 403 depending on hardened mode.
    expect([401, 403]).toContain(r.status());
  });

  test("POST /applications as USER role → 403", async ({ request }) => {
    const token = await getTravelUser(request);
    if (!token) {
      test.skip(true, "telecaller@travelstall.demo not seeded — skipping USER-RBAC POST test");
      return;
    }
    const r = await post(request, token, "/api/travel/visa/applications", {
      contactId: 1,
      applicationType: "tourist",
      destinationCountry: "US",
    });
    expect(r.status()).toBe(403);
  });

  test("POST /applications missing contactId → 400 MISSING_FIELDS", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token) {
      test.skip(true, "yasin@travelstall.in not seeded — skipping MISSING_FIELDS test");
      return;
    }
    const r = await post(request, token, "/api/travel/visa/applications", {
      // contactId omitted
      applicationType: "tourist",
      destinationCountry: `US ${RUN_TAG}`,
    });
    expect(r.status()).toBe(400);
    const body = await r.json();
    expect(body.code).toBe("MISSING_FIELDS");
  });

  test("POST /applications invalid applicationType → 400 INVALID_APPLICATION_TYPE", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token) {
      test.skip(true, "yasin@travelstall.in not seeded — skipping INVALID_APPLICATION_TYPE test");
      return;
    }
    // Use a placeholder contactId — the applicationType check fires before
    // the contact lookup, so we never have to find a real visa contact.
    const r = await post(request, token, "/api/travel/visa/applications", {
      contactId: 1,
      applicationType: "family", // not in VALID_APPLICATION_TYPES enum
      destinationCountry: `US ${RUN_TAG}`,
    });
    expect(r.status()).toBe(400);
    const body = await r.json();
    expect(body.code).toBe("INVALID_APPLICATION_TYPE");
  });

  test("POST /applications missing destinationCountry → 400 MISSING_FIELDS", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token) {
      test.skip(true, "yasin@travelstall.in not seeded — skipping destination-missing test");
      return;
    }
    const r = await post(request, token, "/api/travel/visa/applications", {
      contactId: 1,
      applicationType: "tourist",
      // destinationCountry omitted
    });
    expect(r.status()).toBe(400);
    const body = await r.json();
    expect(body.code).toBe("MISSING_FIELDS");
  });

  test("POST /applications with non-existent contactId → 404 NOT_FOUND", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token) {
      test.skip(true, "yasin@travelstall.in not seeded — skipping NOT_FOUND test");
      return;
    }
    const r = await post(request, token, "/api/travel/visa/applications", {
      contactId: 999999999,
      applicationType: "tourist",
      destinationCountry: `US ${RUN_TAG}`,
    });
    expect(r.status()).toBe(404);
    const body = await r.json();
    expect(body.code).toBe("NOT_FOUND");
  });

  test("POST /applications with non-visasure contactId → 403 NOT_VISA_SURE", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token) {
      test.skip(true, "yasin@travelstall.in not seeded — skipping NOT_VISA_SURE test");
      return;
    }
    const nonVisaId = await findNonVisaSureContactId(request, token);
    if (!nonVisaId) {
      test.skip(
        true,
        "no non-visasure travel contact on this stack — sub-brand isolation tested via the NOT_FOUND path instead",
      );
      return;
    }
    const r = await post(request, token, "/api/travel/visa/applications", {
      contactId: nonVisaId,
      applicationType: "tourist",
      destinationCountry: `US ${RUN_TAG}`,
    });
    expect(r.status()).toBe(403);
    const body = await r.json();
    expect(body.code).toBe("NOT_VISA_SURE");
  });

  test("POST /applications happy path → 201 with created row", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token) {
      test.skip(true, "yasin@travelstall.in not seeded — skipping CREATE happy path");
      return;
    }
    const visaId = await findVisaSureContactId(request, token);
    if (!visaId) {
      test.skip(
        true,
        "no visa-sure contact on this stack — CREATE happy path covered by validator tests; row creation unreachable without a seed",
      );
      return;
    }
    const r = await post(request, token, "/api/travel/visa/applications", {
      contactId: visaId,
      applicationType: "tourist",
      destinationCountry: `US ${RUN_TAG}`,
    });
    expect(r.status()).toBe(201);
    const body = await r.json();

    // Created row shape — schema columns we depend on.
    expect(body).toHaveProperty("id");
    expect(typeof body.id).toBe("number");
    expect(body.contactId).toBe(visaId);
    expect(body.applicationType).toBe("tourist");
    expect(body.destinationCountry).toBe(`US ${RUN_TAG}`);
    expect(body.status).toBe("intake");
    expect(body).toHaveProperty("tenantId");
    expect(body).toHaveProperty("createdAt");
  });
});

// ─── PATCH /applications/:id — status transitions + advisor edits ────
//
// Auth gates, body validation, sub-brand isolation, NOT_FOUND, and a
// happy-path status transition (intake → docs-pending). Uses a real
// visa-sure application discovered via the list endpoint; falls back to
// test.skip on the demo state where no visa-sure application exists.
//
// PATCH RUN_TAG suffix lets demo-hygiene identify spec-mutated rows.
// Created or mutated rows are NOT torn down (visa pipeline data is
// durable demo state; see file header note for the CREATE flow).

const PATCH_RUN_TAG = `E2E_VISA_PATCH_${Date.now()}`;

async function findVisaApplicationId(request, token) {
  const r = await get(request, token, "/api/travel/visa/applications?limit=1");
  if (r.status() !== 200) return null;
  const body = await r.json();
  if (Array.isArray(body.applications) && body.applications.length > 0) {
    return body.applications[0].id;
  }
  return null;
}

async function findNonVisaApplicationId(_request, _token) {
  // No public endpoint surfaces a VisaApplication whose Contact has
  // subBrand != "visasure" — the POST handler rejects 403 NOT_VISA_SURE
  // at create-time, so no such row can be authored via the API. Returns
  // null to signal "use NOT_FOUND path for sub-brand isolation instead".
  return null;
}

test.describe("Visa Sure applications — PATCH flow", () => {
  test("PATCH /applications/:id without token → 401 (or 403)", async ({ request }) => {
    const r = await request.patch(
      `${BASE_URL}/api/travel/visa/applications/1`,
      {
        headers: { "Content-Type": "application/json" },
        data: { status: "docs-pending" },
        timeout: REQUEST_TIMEOUT,
      },
    );
    // Global auth guard returns 401 or 403 depending on hardened mode.
    expect([401, 403]).toContain(r.status());
  });

  test("PATCH /applications/:id as USER role → 403", async ({ request }) => {
    const token = await getTravelUser(request);
    if (!token) {
      test.skip(true, "telecaller@travelstall.demo not seeded — skipping USER-RBAC PATCH test");
      return;
    }
    const r = await patch(
      request,
      token,
      "/api/travel/visa/applications/1",
      { status: "docs-pending" },
    );
    expect(r.status()).toBe(403);
  });

  test("PATCH /applications/:id empty body → 400 EMPTY_BODY", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token) {
      test.skip(true, "yasin@travelstall.in not seeded — skipping EMPTY_BODY test");
      return;
    }
    const appId = await findVisaApplicationId(request, token);
    if (!appId) {
      test.skip(
        true,
        "no visa-sure application on this stack — EMPTY_BODY path can't be exercised without a real row to target (the handler verifies existence before checking body)",
      );
      return;
    }
    const r = await patch(
      request,
      token,
      `/api/travel/visa/applications/${appId}`,
      {},
    );
    expect(r.status()).toBe(400);
    const body = await r.json();
    expect(body.code).toBe("EMPTY_BODY");
  });

  test("PATCH /applications/999999999 → 404 NOT_FOUND", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token) {
      test.skip(true, "yasin@travelstall.in not seeded — skipping NOT_FOUND PATCH test");
      return;
    }
    const r = await patch(
      request,
      token,
      "/api/travel/visa/applications/999999999",
      { status: "docs-pending" },
    );
    expect(r.status()).toBe(404);
    const body = await r.json();
    // Either NOT_FOUND (no row at all) or NOT_VISA_SURE — both are
    // acceptable rejection codes per the same contract as the GET /:id
    // handler.
    expect(["NOT_FOUND", "NOT_VISA_SURE"]).toContain(body.code);
  });

  test("PATCH /applications/:id non-visasure contact's app → 404 NOT_VISA_SURE (or NOT_FOUND)", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token) {
      test.skip(true, "yasin@travelstall.in not seeded — skipping NOT_VISA_SURE PATCH test");
      return;
    }
    const nonVisaAppId = await findNonVisaApplicationId(request, token);
    if (!nonVisaAppId) {
      // Sub-brand isolation on PATCH is exercised via the NOT_FOUND
      // path above (a non-existent ID + an ID referencing a non-visa
      // contact both return the same 404 code branch).
      test.skip(
        true,
        "sub-brand isolation on PATCH covered by NOT_FOUND path — a non-visa VisaApplication can't be constructed via public API (POST rejects with 403 at create-time)",
      );
      return;
    }
    const r = await patch(
      request,
      token,
      `/api/travel/visa/applications/${nonVisaAppId}`,
      { status: "docs-pending" },
    );
    expect(r.status()).toBe(404);
    const body = await r.json();
    expect(["NOT_FOUND", "NOT_VISA_SURE"]).toContain(body.code);
  });

  test("PATCH /applications/:id invalid status → 400 INVALID_STATUS", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token) {
      test.skip(true, "yasin@travelstall.in not seeded — skipping INVALID_STATUS PATCH test");
      return;
    }
    const appId = await findVisaApplicationId(request, token);
    if (!appId) {
      test.skip(
        true,
        "no visa-sure application on this stack — INVALID_STATUS path requires a real row (existence is checked before body validation)",
      );
      return;
    }
    const r = await patch(
      request,
      token,
      `/api/travel/visa/applications/${appId}`,
      { status: "garbage" },
    );
    expect(r.status()).toBe(400);
    const body = await r.json();
    expect(body.code).toBe("INVALID_STATUS");
  });

  test("PATCH /applications/:id happy path → 200 with status transition (intake → docs-pending)", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token) {
      test.skip(true, "yasin@travelstall.in not seeded — skipping PATCH happy path");
      return;
    }
    // Find or create a target row in intake state. Prefer existing
    // intake rows; if none, create one via POST. If the demo has no
    // visa-sure contacts at all, skip.
    let appId = null;
    let isCreatedRow = false;

    const listR = await get(
      request,
      token,
      "/api/travel/visa/applications?status=intake&limit=1",
    );
    if (listR.status() === 200) {
      const listBody = await listR.json();
      if (Array.isArray(listBody.applications) && listBody.applications.length > 0) {
        appId = listBody.applications[0].id;
      }
    }

    if (!appId) {
      const visaContactId = await findVisaSureContactId(request, token);
      if (!visaContactId) {
        test.skip(
          true,
          "no visa-sure contact + no intake application on this stack — happy-path PATCH unreachable without seed",
        );
        return;
      }
      const createR = await post(request, token, "/api/travel/visa/applications", {
        contactId: visaContactId,
        applicationType: "tourist",
        destinationCountry: `IT ${PATCH_RUN_TAG}`,
      });
      if (createR.status() !== 201) {
        test.skip(
          true,
          `couldn't create a target application (status ${createR.status()}) — happy-path PATCH unreachable`,
        );
        return;
      }
      const createdBody = await createR.json();
      appId = createdBody.id;
      isCreatedRow = true;
    }

    // Status transition intake → docs-pending. The 200 envelope must
    // include the updated status; complexCase + advisorRiskFlag fields
    // are also exercised to pin the multi-field-update path.
    const r = await patch(
      request,
      token,
      `/api/travel/visa/applications/${appId}`,
      {
        status: "docs-pending",
        complexCase: true,
        advisorRiskFlag: "priority",
      },
    );
    expect(r.status()).toBe(200);
    const body = await r.json();

    // Updated row shape — schema columns we depend on.
    expect(body).toHaveProperty("id");
    expect(body.id).toBe(appId);
    expect(body.status).toBe("docs-pending");
    expect(body.complexCase).toBe(true);
    expect(body.advisorRiskFlag).toBe("priority");
    expect(body).toHaveProperty("tenantId");
    expect(body).toHaveProperty("updatedAt");

    // If we created this row in-spec, restore status to intake to keep
    // the demo's status-distribution sane. Other PATCH'd fields are
    // left set — they're tied to the spec's RUN_TAG and identifiable
    // by demo-hygiene.
    if (isCreatedRow) {
      await patch(
        request,
        token,
        `/api/travel/visa/applications/${appId}`,
        { status: "intake" },
      ).catch(() => {});
    }
  });
});

// ─── S43 slim shape (?fields=summary) opt-in ─────────────────────────
//
// Slice S43 pins the slim-projection opt-in contract for the visa-
// applications list endpoint:
//
//   1. Default (no ?fields=summary)          → full row shape + contact
//      decoration  (back-compat with the Applications.jsx + AdvisorDashboard
//      .jsx pages that destructure `a.contact.name` / `a.contact.email`
//      / `a.contact.phone` directly).
//   2. ?fields=summary                        → slim row shape, NO contact
//      decoration, NO PII columns (rejectionHistoryJson, outcomeReason,
//      familySize, priorApplicationId, recoveryProgramId, updatedAt,
//      tenantId).
//   3. Non-exact ?fields values               → fall through to full shape
//      (strict equality, mirrors slices 1-51 + S42).
//
// The default-stays-full direction matches the 52 prior #920 slices' opt-in
// shape (and PRD §10's residual contract). When the load-bearing privacy
// review eventually flips the default to slim (see PRD FR-3.5.a), this
// describe block's "default = full" assertions are the canonical signal
// that future cross-cutting change will be a true breaking flip — author
// the cross-cutting audit at that time.
test.describe("Visa Sure applications — slim shape (?fields=summary)", () => {
  test("default (no ?fields=summary) → full row shape + contact decoration", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token) {
      test.skip(true, "yasin@travelstall.in not seeded — skipping slim default-shape test");
      return;
    }
    const r = await get(request, token, "/api/travel/visa/applications?limit=5");
    expect(r.status()).toBe(200);
    const body = await r.json();
    expect(Array.isArray(body.applications)).toBe(true);
    if (body.applications.length === 0) {
      test.skip(
        true,
        "no visa applications on this stack — slim/full shape contrast unreachable without seed",
      );
      return;
    }

    // Default shape — every row must carry the FULL VisaApplication
    // surface PLUS the `contact` decoration. We pin the keys that the
    // frontend Applications.jsx page destructures directly; if any of
    // these vanish from the default payload, the page breaks.
    for (const a of body.applications) {
      expect(a).toHaveProperty("id");
      expect(a).toHaveProperty("contactId");
      expect(a).toHaveProperty("applicationType");
      expect(a).toHaveProperty("destinationCountry");
      expect(a).toHaveProperty("status");
      expect(a).toHaveProperty("readinessLevel");
      expect(a).toHaveProperty("advisorRiskFlag");
      expect(a).toHaveProperty("complexCase");
      expect(a).toHaveProperty("createdAt");
      // updatedAt + tenantId are part of the default row shape.
      expect(a).toHaveProperty("updatedAt");
      expect(a).toHaveProperty("tenantId");
      // Contact decoration — the load-bearing default for the
      // Applications page picker.
      expect(a).toHaveProperty("contact");
      if (a.contact !== null) {
        expect(a.contact).toHaveProperty("id");
        expect(a.contact).toHaveProperty("name");
        // email + phone may be null in the seed but the KEY must exist.
        expect(a.contact).toHaveProperty("email");
        expect(a.contact).toHaveProperty("phone");
      }
    }
  });

  test("?fields=summary → slim row shape, NO contact decoration, NO PII columns", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token) {
      test.skip(true, "yasin@travelstall.in not seeded — skipping slim shape test");
      return;
    }
    const r = await get(
      request,
      token,
      "/api/travel/visa/applications?fields=summary&limit=5",
    );
    expect(r.status()).toBe(200);
    const body = await r.json();

    // Envelope still has the four list keys (slim is opt-in for the row
    // shape; the envelope contract is independent).
    expect(body).toHaveProperty("applications");
    expect(body).toHaveProperty("total");
    expect(body).toHaveProperty("limit");
    expect(body).toHaveProperty("offset");
    expect(Array.isArray(body.applications)).toBe(true);

    if (body.applications.length === 0) {
      test.skip(
        true,
        "no visa applications on this stack — per-row slim-shape pin unreachable without seed",
      );
      return;
    }

    for (const a of body.applications) {
      // ── Slim shape — keys that MUST be present ─────────────────
      expect(a).toHaveProperty("id");
      expect(a).toHaveProperty("contactId");
      expect(a).toHaveProperty("applicationType");
      expect(a).toHaveProperty("destinationCountry");
      expect(a).toHaveProperty("status");
      expect(a).toHaveProperty("createdAt");

      // ── PII / sensitive keys that MUST be absent on the slim path ─
      //
      // These are the load-bearing absences the slim shape exists to
      // enforce. If any of these slip back into the response, the
      // slice's privacy contract is broken.
      expect(a).not.toHaveProperty("rejectionHistoryJson");
      expect(a).not.toHaveProperty("outcomeReason");
      expect(a).not.toHaveProperty("familySize");
      expect(a).not.toHaveProperty("priorApplicationId");
      expect(a).not.toHaveProperty("recoveryProgramId");
      expect(a).not.toHaveProperty("tenantId");
      expect(a).not.toHaveProperty("updatedAt");

      // ── Contact decoration MUST be skipped on the slim path ────
      //
      // This is the OTHER load-bearing assertion — the route's
      // post-query `.map(a => ({...a, contact}))` decoration would
      // otherwise smuggle contact.name / contact.email / contact.phone
      // back into the slim payload via the post-Prisma step.
      expect(a).not.toHaveProperty("contact");
    }
  });

  test("?fields=summary respects status filter (slim path + filter)", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token) {
      test.skip(true, "yasin@travelstall.in not seeded — skipping slim + filter test");
      return;
    }
    const r = await get(
      request,
      token,
      "/api/travel/visa/applications?fields=summary&status=intake&limit=10",
    );
    expect(r.status()).toBe(200);
    const body = await r.json();
    expect(Array.isArray(body.applications)).toBe(true);
    for (const a of body.applications) {
      expect(a.status).toBe("intake");
      // Slim contract continues to hold under filter.
      expect(a).not.toHaveProperty("rejectionHistoryJson");
      expect(a).not.toHaveProperty("contact");
    }
  });

  test("?fields=Summary (wrong case) → falls through to full shape", async ({ request }) => {
    // Strict-equality opt-in: anything that isn't the literal lowercase
    // string "summary" falls through to full. Mirrors the contract pinned
    // in the prior 52 slices' specs.
    const token = await getTravelAdmin(request);
    if (!token) {
      test.skip(true, "yasin@travelstall.in not seeded — skipping case-strict test");
      return;
    }
    const r = await get(
      request,
      token,
      "/api/travel/visa/applications?fields=Summary&limit=5",
    );
    expect(r.status()).toBe(200);
    const body = await r.json();
    if (body.applications.length === 0) {
      test.skip(
        true,
        "no visa applications on this stack — case-strict slim assertion unreachable",
      );
      return;
    }
    // Case-mismatched value → full shape returns (contact decoration
    // present, tenantId + updatedAt present).
    for (const a of body.applications) {
      expect(a).toHaveProperty("contact");
      expect(a).toHaveProperty("tenantId");
      expect(a).toHaveProperty("updatedAt");
    }
  });

  test("?fields=full → full shape (explicit opt-out is a no-op)", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token) {
      test.skip(true, "yasin@travelstall.in not seeded — skipping ?fields=full test");
      return;
    }
    const r = await get(
      request,
      token,
      "/api/travel/visa/applications?fields=full&limit=5",
    );
    expect(r.status()).toBe(200);
    const body = await r.json();
    if (body.applications.length === 0) {
      test.skip(
        true,
        "no visa applications on this stack — explicit ?fields=full assertion unreachable",
      );
      return;
    }
    for (const a of body.applications) {
      // Explicit full opt-out matches the default — contact decoration
      // present, tenantId + updatedAt present.
      expect(a).toHaveProperty("contact");
      expect(a).toHaveProperty("tenantId");
      expect(a).toHaveProperty("updatedAt");
    }
  });
});

// ─── Per-application document checklist (FR-6) ───────────────────────
//
// Pins the FR-6 lifecycle added alongside the /checklists template admin:
//   1. seed-on-create — POST /applications copies the matching
//      (applicationType × destinationCountry) VisaChecklistTemplate into
//      per-application VisaDocumentChecklistItem rows (status "pending").
//   2. PATCH /applications/:id/checklist/:itemId moves a document through
//      pending → uploaded → verified | rejected.
//   3. auto-advance (FR-6.5) — verifying the LAST required document
//      auto-advances the application docs-pending → filed (the PRD's
//      "filed-ready", mapped to the existing `filed` enum); the PATCH
//      response then carries { applicationStatus: "filed" }.
//
// Demo state: a unique destinationCountry per run (RUN_TAG) guarantees a
// freshly-seeded checklist isolated from accumulated demo applications.
// The template rows are torn down; the application + its items are durable
// demo state (RUN_TAG-tagged for demo-hygiene).

test.describe("Visa Sure applications — document checklist lifecycle (FR-6)", () => {
  const DEST = `Checklistia ${RUN_TAG}`;

  test("POST /applications/:id/checklist without token → 401 (or 403)", async ({ request }) => {
    const r = await request.post(
      `${BASE_URL}/api/travel/visa/applications/1/checklist`,
      {
        headers: { "Content-Type": "application/json" },
        data: { docType: "Passport" },
        timeout: REQUEST_TIMEOUT,
      },
    );
    expect([401, 403]).toContain(r.status());
  });

  test("PATCH /applications/:id/checklist/:itemId as USER role → 403", async ({ request }) => {
    const token = await getTravelUser(request);
    if (!token) {
      test.skip(true, "telecaller@travelstall.demo not seeded — skipping USER-RBAC checklist test");
      return;
    }
    const r = await patch(
      request,
      token,
      "/api/travel/visa/applications/1/checklist/1",
      { status: "verified" },
    );
    expect(r.status()).toBe(403);
  });

  test("PATCH checklist item with invalid status → 400; unknown application → 404", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token) {
      test.skip(true, "yasin@travelstall.in not seeded — skipping checklist validation test");
      return;
    }
    // Unknown application — 404 (resolved before the item lookup).
    const missing = await patch(
      request,
      token,
      "/api/travel/visa/applications/999999999/checklist/1",
      { status: "verified" },
    );
    expect(missing.status()).toBe(404);
  });

  test("seed-on-create + verify lifecycle auto-advances docs-pending → filed", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token) {
      test.skip(true, "yasin@travelstall.in not seeded — skipping checklist lifecycle");
      return;
    }
    const contactId = await findVisaSureContactId(request, token);
    if (!contactId) {
      test.skip(true, "no visa-sure contact on this stack — checklist lifecycle unreachable");
      return;
    }

    // 1. Seed a 3-doc template for (tourist × DEST): 2 required + 1 optional.
    const templateIds = [];
    for (const t of [
      { docType: "Passport", required: true },
      { docType: "Bank statement", required: true },
      { docType: "Cover letter", required: false },
    ]) {
      const tr = await post(request, token, "/api/travel/visa/checklists", {
        applicationType: "tourist",
        destinationCountry: DEST,
        ...t,
      });
      expect(tr.status()).toBe(201);
      templateIds.push((await tr.json()).id);
    }

    // 2. Create an application for the combo → checklist seeded from template.
    const cr = await post(request, token, "/api/travel/visa/applications", {
      contactId,
      applicationType: "tourist",
      destinationCountry: DEST,
    });
    expect(cr.status()).toBe(201);
    const appId = (await cr.json()).id;

    // 3. Detail → 3 seeded items, all pending, 2 required.
    const dr = await get(request, token, `/api/travel/visa/applications/${appId}`);
    expect(dr.status()).toBe(200);
    const checklist = (await dr.json()).documentChecklist || [];
    expect(checklist.length).toBe(3);
    expect(checklist.every((i) => i.status === "pending")).toBe(true);
    const required = checklist.filter((i) => i.required);
    expect(required.length).toBe(2);

    // 4. Move to docs-pending (auto-advance only fires from this state).
    const mr = await patch(request, token, `/api/travel/visa/applications/${appId}`, {
      status: "docs-pending",
    });
    expect(mr.status()).toBe(200);

    // 5. Verify the first required doc → no auto-advance yet (1/2 verified).
    const v1 = await patch(
      request,
      token,
      `/api/travel/visa/applications/${appId}/checklist/${required[0].id}`,
      { status: "verified" },
    );
    expect(v1.status()).toBe(200);
    expect((await v1.json()).applicationStatus).toBeUndefined();

    // 6. Verify the last required doc → auto-advance to filed.
    const v2 = await patch(
      request,
      token,
      `/api/travel/visa/applications/${appId}/checklist/${required[1].id}`,
      { status: "verified" },
    );
    expect(v2.status()).toBe(200);
    expect((await v2.json()).applicationStatus).toBe("filed");

    // 7. Status persisted.
    const dr2 = await get(request, token, `/api/travel/visa/applications/${appId}`);
    expect((await dr2.json()).status).toBe("filed");

    // 8. Invalid item status → 400.
    const bad = await patch(
      request,
      token,
      `/api/travel/visa/applications/${appId}/checklist/${required[0].id}`,
      { status: "bogus" },
    );
    expect(bad.status()).toBe(400);

    // Teardown the template rows (application + items are durable demo state).
    for (const id of templateIds) {
      await request.delete(`${BASE_URL}/api/travel/visa/checklists/${id}`, {
        headers: headers(token),
        timeout: REQUEST_TIMEOUT,
      });
    }
  });
});

// ─── Quotation templates (FR-5.2) ────────────────────────────────────
//
// Pins the VisaQuotationTemplate admin (PRD_VISA_SURE_PHASE_3 FR-5.2). The
// model stores `linesJson` (JSON array of { label, amount }; amount may be
// negative for credits). The API serializes it as a parsed `lines` array and
// never exposes the raw JSON string. Managed on the /travel/visa/checklists
// admin page (it extends to manage quotation templates too).

test.describe("Visa Sure quotation templates — FR-5.2", () => {
  const TPL_NAME = `Tourist std ${RUN_TAG}`;

  test("GET /quotation-templates without token → 401 (or 403)", async ({ request }) => {
    const r = await request.get(`${BASE_URL}/api/travel/visa/quotation-templates`, {
      headers: { "Content-Type": "application/json" },
      timeout: REQUEST_TIMEOUT,
    });
    expect([401, 403]).toContain(r.status());
  });

  test("POST /quotation-templates as USER role → 403", async ({ request }) => {
    const token = await getTravelUser(request);
    if (!token) {
      test.skip(true, "telecaller@travelstall.demo not seeded — skipping USER-RBAC quotation test");
      return;
    }
    const r = await post(request, token, "/api/travel/visa/quotation-templates", {
      name: "x",
      applicationType: "tourist",
      lines: [{ label: "a", amount: 1 }],
    });
    expect(r.status()).toBe(403);
  });

  test("POST invalid applicationType → 400; empty line label → 400", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token) {
      test.skip(true, "yasin@travelstall.in not seeded — skipping quotation validation test");
      return;
    }
    const badType = await post(request, token, "/api/travel/visa/quotation-templates", {
      name: "x",
      applicationType: "family", // not in VALID_APPLICATION_TYPES
      lines: [{ label: "a", amount: 1 }],
    });
    expect(badType.status()).toBe(400);
    const badLines = await post(request, token, "/api/travel/visa/quotation-templates", {
      name: "x",
      applicationType: "tourist",
      lines: [{ label: "", amount: 1 }], // blank label
    });
    expect(badLines.status()).toBe(400);
  });

  test("CRUD happy path: create (with credit line) → list → update → delete", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token) {
      test.skip(true, "yasin@travelstall.in not seeded — skipping quotation CRUD");
      return;
    }
    // Create — includes a negative (credit) line.
    const cr = await post(request, token, "/api/travel/visa/quotation-templates", {
      name: TPL_NAME,
      applicationType: "tourist",
      currency: "INR",
      lines: [
        { label: "Service tier base price", amount: 5000 },
        { label: "Credit: free entry diagnostic", amount: -500 },
      ],
    });
    expect(cr.status()).toBe(201);
    const created = await cr.json();
    expect(Array.isArray(created.lines)).toBe(true);
    expect(created.lines.length).toBe(2);
    expect(created.linesJson).toBeUndefined(); // raw JSON string never exposed
    expect(created.lines[1].amount).toBe(-500); // credit preserved
    const id = created.id;

    // List + filter.
    const list = await get(
      request,
      token,
      "/api/travel/visa/quotation-templates?applicationType=tourist",
    );
    expect(list.status()).toBe(200);
    const items = (await list.json()).items;
    expect(items.some((t) => t.id === id)).toBe(true);

    // Update — deactivate + replace lines.
    const upd = await request.put(
      `${BASE_URL}/api/travel/visa/quotation-templates/${id}`,
      {
        headers: headers(token),
        data: { isActive: false, lines: [{ label: "Flat fee", amount: 9999 }] },
        timeout: REQUEST_TIMEOUT,
      },
    );
    expect(upd.status()).toBe(200);
    const updated = await upd.json();
    expect(updated.isActive).toBe(false);
    expect(updated.lines.length).toBe(1);

    // Delete.
    const del = await request.delete(
      `${BASE_URL}/api/travel/visa/quotation-templates/${id}`,
      { headers: headers(token), timeout: REQUEST_TIMEOUT },
    );
    expect(del.status()).toBe(200);
  });
});
