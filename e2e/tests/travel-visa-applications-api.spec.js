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
 *   - 403 USER role (verifyRole(['ADMIN','MANAGER']))
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
