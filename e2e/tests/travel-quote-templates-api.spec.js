// @ts-check
/**
 * Gate spec — travel-vertical Quote Template library CRUD + apply-to-quote.
 *
 * Pins the S31 / S50 contract at `backend/routes/travel_quote_templates.js`.
 * The route exposes six endpoints — all gated behind `verifyToken` +
 * `requireTravelTenant` (vertical guard); write paths additionally gated
 * behind `verifyRole(["ADMIN", "MANAGER"])`; DELETE is ADMIN-only:
 *
 *   GET    /api/travel/quote-templates                  — paginated list
 *   POST   /api/travel/quote-templates                  — create (ADMIN/MGR)
 *   GET    /api/travel/quote-templates/:id              — fetch one
 *   PATCH  /api/travel/quote-templates/:id              — update (ADMIN/MGR)
 *   DELETE /api/travel/quote-templates/:id              — soft-delete (ADMIN)
 *   POST   /api/travel/quote-templates/:id/apply        — clone lines onto
 *                                                          target quote
 *                                                          (ADMIN/MGR)
 *
 * Spec covers:
 *   - Auth gates (401/403 without token; 403 WRONG_VERTICAL from generic).
 *   - Validation: MISSING_NAME, MISSING_LINES_JSON, INVALID_CURRENCY,
 *     INVALID_LINES_JSON, INVALID_ID, EMPTY_BODY, INVALID_QUOTE_ID.
 *   - Happy CRUD round-trip + soft-delete (isActive=false).
 *   - DELETE RBAC: MANAGER → 403; ADMIN → 200.
 *   - Tenant-scope: unknown id → 404 QUOTE_TEMPLATE_NOT_FOUND.
 *   - Apply-to-quote idempotency: 409 ALREADY_HAS_LINES on re-apply.
 *
 * Auth deps:
 *   - yasin@travelstall.in (travel ADMIN, seed-travel.js)
 *   - rfu-advisor@travelstall.demo (travel MANAGER, seed-travel.js)
 *   - admin@globussoft.com (generic ADMIN, seed.js — vertical guard probe)
 *
 * Cleanup: all created template rows are soft-deleted via DELETE in
 * afterAll. Templates are tagged with RUN_TAG so demo-scrub can sweep
 * any residue. Target quote (created for the apply tests) is hard-
 * deleted via the travel_quotes DELETE handler.
 */

const { test, expect } = require("@playwright/test");

test.describe.configure({ mode: "serial" });

const BASE_URL = process.env.BASE_URL || "https://crm.globusdemos.com";
const REQUEST_TIMEOUT = 60000;
const RUN_TAG = `E2E_TRAVEL_QT_${Date.now()}`;

let travelAdminToken = null;
let travelManagerToken = null;
let genericAdminToken = null;
let testContactId = null;
let testQuoteId = null;

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
    travelManagerToken = await loginAs(request, "rfu-advisor@travelstall.demo", "password123");
  }
  return travelManagerToken;
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
      headers: headers(token),
      timeout: REQUEST_TIMEOUT,
    }),
  );
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
async function patch(request, token, path, body) {
  return retryOn5xx(() =>
    request.patch(`${BASE_URL}${path}`, {
      headers: headers(token),
      data: body ?? {},
      timeout: REQUEST_TIMEOUT,
    }),
  );
}
async function del(request, token, path) {
  return retryOn5xx(() =>
    request.delete(`${BASE_URL}${path}`, {
      headers: headers(token),
      timeout: REQUEST_TIMEOUT,
    }),
  );
}

// Tracking for cleanup
const created = { templateIds: [] };

const SAMPLE_LINES = [
  {
    lineType: "hotel",
    description: "Makkah 7n stay",
    quantity: 1,
    unitPrice: 75000,
    sortOrder: 0,
  },
  {
    lineType: "flight",
    description: "BLR-JED economy",
    quantity: 1,
    unitPrice: 35000,
    sortOrder: 1,
  },
];

test.beforeAll(async ({ request }) => {
  const token = await getTravelAdmin(request);
  if (!token) return;
  // Create a contact + quote for the /apply tests. Contact uses RUN_TAG so
  // demo-scrub sweeps it; quote is hard-deleted by afterAll.
  const cRes = await post(request, token, "/api/contacts", {
    name: `${RUN_TAG} Apply Test Contact`,
    email: `${RUN_TAG.toLowerCase()}@e2e.test`,
    phone: `+91${String(Date.now()).slice(-10)}`,
    subBrand: "rfu",
  });
  if (cRes.ok()) {
    const body = await cRes.json();
    testContactId = body.id || body.contact?.id;
  }
  if (!testContactId) return;

  const qRes = await post(request, token, "/api/travel/quotes", {
    subBrand: "rfu",
    contactId: testContactId,
    currency: "INR",
  });
  if (qRes.ok()) {
    const body = await qRes.json();
    testQuoteId = body.id;
  }
});

test.afterAll(async ({ request }) => {
  const token = await getTravelAdmin(request);
  if (!token) return;
  const deadline = Date.now() + 40_000;
  for (const id of created.templateIds) {
    if (Date.now() > deadline) break;
    await del(request, token, `/api/travel/quote-templates/${id}`).catch(() => {});
  }
  if (testQuoteId) {
    await del(request, token, `/api/travel/quotes/${testQuoteId}`).catch(() => {});
  }
  if (testContactId) {
    await del(request, token, `/api/contacts/${testContactId}`).catch(() => {});
  }
});

// ─── Vertical guard + auth ──────────────────────────────────────────

test.describe("Travel quote-templates API — vertical guard + auth", () => {
  test("GET / without auth → 401/403", async ({ request }) => {
    const res = await request.get(`${BASE_URL}/api/travel/quote-templates`, {
      timeout: REQUEST_TIMEOUT,
    });
    expect([401, 403]).toContain(res.status());
  });

  test("POST / without auth → 401/403", async ({ request }) => {
    const res = await request.post(`${BASE_URL}/api/travel/quote-templates`, {
      data: { name: `${RUN_TAG} noauth`, linesJson: JSON.stringify(SAMPLE_LINES) },
      headers: { "Content-Type": "application/json" },
      timeout: REQUEST_TIMEOUT,
    });
    expect([401, 403]).toContain(res.status());
  });

  test("GET / from generic-vertical caller → 403 WRONG_VERTICAL", async ({ request }) => {
    const token = await getGenericAdmin(request);
    if (!token) test.skip(true, "admin@globussoft.com not seeded");
    const res = await get(request, token, "/api/travel/quote-templates");
    expect(res.status()).toBe(403);
    expect((await res.json()).code).toBe("WRONG_VERTICAL");
  });

  test("POST / from generic-vertical caller → 403 WRONG_VERTICAL", async ({ request }) => {
    const token = await getGenericAdmin(request);
    if (!token) test.skip(true, "admin@globussoft.com not seeded");
    const res = await post(request, token, "/api/travel/quote-templates", {
      name: `${RUN_TAG} cross-vertical`,
      linesJson: JSON.stringify(SAMPLE_LINES),
    });
    expect(res.status()).toBe(403);
    expect((await res.json()).code).toBe("WRONG_VERTICAL");
  });
});

// ─── Create + validation ────────────────────────────────────────────

test.describe("Travel quote-templates API — create + validation", () => {
  test("POST / happy path creates a template with 201 and round-trips fields", async ({
    request,
  }) => {
    const token = await getTravelAdmin(request);
    expect(token, "yasin@travelstall.in must be seeded").toBeTruthy();
    const res = await post(request, token, "/api/travel/quote-templates", {
      name: `${RUN_TAG} Umrah-7d`,
      description: `${RUN_TAG} canonical Umrah package`,
      category: "Umrah",
      currency: "INR",
      linesJson: JSON.stringify(SAMPLE_LINES),
    });
    expect(res.status(), `create: ${await res.text()}`).toBe(201);
    const body = await res.json();
    expect(body.id).toBeTruthy();
    expect(body.name).toBe(`${RUN_TAG} Umrah-7d`);
    expect(body.category).toBe("Umrah");
    expect(body.currency).toBe("INR");
    expect(body.isActive).toBe(true);
    expect(typeof body.linesJson).toBe("string");
    const lines = JSON.parse(body.linesJson);
    expect(Array.isArray(lines)).toBe(true);
    expect(lines).toHaveLength(2);
    expect(lines[0].lineType).toBe("hotel");
    created.templateIds.push(body.id);
  });

  test("POST / missing name → 400 MISSING_NAME", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token) test.skip(true, "travel admin not available");
    const res = await post(request, token, "/api/travel/quote-templates", {
      linesJson: JSON.stringify(SAMPLE_LINES),
    });
    expect(res.status()).toBe(400);
    expect((await res.json()).code).toBe("MISSING_NAME");
  });

  test("POST / missing linesJson → 400 MISSING_LINES_JSON", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token) test.skip(true, "travel admin not available");
    const res = await post(request, token, "/api/travel/quote-templates", {
      name: `${RUN_TAG} no-lines`,
    });
    expect(res.status()).toBe(400);
    expect((await res.json()).code).toBe("MISSING_LINES_JSON");
  });

  test("POST / invalid currency (lowercase) → 400 INVALID_CURRENCY", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token) test.skip(true, "travel admin not available");
    const res = await post(request, token, "/api/travel/quote-templates", {
      name: `${RUN_TAG} bad-currency`,
      currency: "inr",
      linesJson: JSON.stringify(SAMPLE_LINES),
    });
    expect(res.status()).toBe(400);
    expect((await res.json()).code).toBe("INVALID_CURRENCY");
  });

  test("POST / linesJson is not an array → 400 INVALID_LINES_JSON", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token) test.skip(true, "travel admin not available");
    const res = await post(request, token, "/api/travel/quote-templates", {
      name: `${RUN_TAG} bad-lines`,
      linesJson: JSON.stringify({ not: "an array" }),
    });
    expect(res.status()).toBe(400);
    expect((await res.json()).code).toBe("INVALID_LINES_JSON");
  });

  test("POST / linesJson item missing description → 400 INVALID_LINES_JSON", async ({
    request,
  }) => {
    const token = await getTravelAdmin(request);
    if (!token) test.skip(true, "travel admin not available");
    const res = await post(request, token, "/api/travel/quote-templates", {
      name: `${RUN_TAG} item-no-desc`,
      linesJson: JSON.stringify([{ lineType: "hotel" }]),
    });
    expect(res.status()).toBe(400);
    expect((await res.json()).code).toBe("INVALID_LINES_JSON");
  });

  test("POST / linesJson item with bad lineType → 400 INVALID_LINES_JSON", async ({
    request,
  }) => {
    const token = await getTravelAdmin(request);
    if (!token) test.skip(true, "travel admin not available");
    const res = await post(request, token, "/api/travel/quote-templates", {
      name: `${RUN_TAG} bad-type`,
      linesJson: JSON.stringify([{ lineType: "submarine", description: "x" }]),
    });
    expect(res.status()).toBe(400);
    expect((await res.json()).code).toBe("INVALID_LINES_JSON");
  });
});

// ─── List + get ─────────────────────────────────────────────────────

test.describe("Travel quote-templates API — list + get", () => {
  test("GET / returns paginated tenant-scoped list with limit/offset/total", async ({
    request,
  }) => {
    const token = await getTravelAdmin(request);
    if (!token) test.skip(true, "travel admin not available");
    const res = await get(request, token, "/api/travel/quote-templates?limit=10&offset=0");
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.items)).toBe(true);
    expect(Number.isFinite(body.total)).toBe(true);
    expect(body.limit).toBe(10);
    expect(body.offset).toBe(0);
    // Our just-created template MUST show up in the first page (newest-first).
    if (created.templateIds.length > 0) {
      const ids = body.items.map((t) => t.id);
      expect(ids).toContain(created.templateIds[0]);
    }
  });

  test("GET /?category= filters", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token || created.templateIds.length === 0) test.skip(true, "no template seeded");
    const res = await get(request, token, "/api/travel/quote-templates?category=Umrah");
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.items.every((t) => t.category === "Umrah")).toBe(true);
  });

  test("GET /:id returns the created template", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token || created.templateIds.length === 0) test.skip(true, "no template");
    const id = created.templateIds[0];
    const res = await get(request, token, `/api/travel/quote-templates/${id}`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.id).toBe(id);
    expect(body.name).toBe(`${RUN_TAG} Umrah-7d`);
  });

  test("GET /:id unknown → 404 QUOTE_TEMPLATE_NOT_FOUND", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token) test.skip(true, "travel admin not available");
    const res = await get(request, token, "/api/travel/quote-templates/9999999");
    expect(res.status()).toBe(404);
    expect((await res.json()).code).toBe("QUOTE_TEMPLATE_NOT_FOUND");
  });

  test("GET /:id non-numeric id → 400 INVALID_ID", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token) test.skip(true, "travel admin not available");
    const res = await get(request, token, "/api/travel/quote-templates/abc");
    expect(res.status()).toBe(400);
    expect((await res.json()).code).toBe("INVALID_ID");
  });
});

// ─── Patch ──────────────────────────────────────────────────────────

test.describe("Travel quote-templates API — patch", () => {
  test("PATCH /:id updates name + description, returns updated row", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token || created.templateIds.length === 0) test.skip(true, "no template");
    const id = created.templateIds[0];
    const res = await patch(request, token, `/api/travel/quote-templates/${id}`, {
      name: `${RUN_TAG} Umrah-7d (revised)`,
      description: `${RUN_TAG} updated desc`,
    });
    expect(res.status(), `patch: ${await res.text()}`).toBe(200);
    const body = await res.json();
    expect(body.id).toBe(id);
    expect(body.name).toBe(`${RUN_TAG} Umrah-7d (revised)`);
    expect(body.description).toBe(`${RUN_TAG} updated desc`);
  });

  test("PATCH /:id with empty body → 400 EMPTY_BODY", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token || created.templateIds.length === 0) test.skip(true, "no template");
    const res = await patch(
      request,
      token,
      `/api/travel/quote-templates/${created.templateIds[0]}`,
      {},
    );
    expect(res.status()).toBe(400);
    expect((await res.json()).code).toBe("EMPTY_BODY");
  });

  test("PATCH /:id with bad currency → 400 INVALID_CURRENCY", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token || created.templateIds.length === 0) test.skip(true, "no template");
    const res = await patch(
      request,
      token,
      `/api/travel/quote-templates/${created.templateIds[0]}`,
      { currency: "rupee" },
    );
    expect(res.status()).toBe(400);
    expect((await res.json()).code).toBe("INVALID_CURRENCY");
  });

  test("PATCH /:id unknown → 404 QUOTE_TEMPLATE_NOT_FOUND", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token) test.skip(true, "travel admin not available");
    const res = await patch(request, token, "/api/travel/quote-templates/9999999", {
      name: "x",
    });
    expect(res.status()).toBe(404);
    expect((await res.json()).code).toBe("QUOTE_TEMPLATE_NOT_FOUND");
  });
});

// ─── Apply-to-quote ─────────────────────────────────────────────────

test.describe("Travel quote-templates API — apply-to-quote", () => {
  test("POST /:id/apply happy path inserts template lines into the quote", async ({
    request,
  }) => {
    const token = await getTravelAdmin(request);
    if (!token || created.templateIds.length === 0 || !testQuoteId) {
      test.skip(true, "deps missing");
    }
    const templateId = created.templateIds[0];
    const res = await post(
      request,
      token,
      `/api/travel/quote-templates/${templateId}/apply`,
      { quoteId: testQuoteId },
    );
    expect(res.status(), `apply: ${await res.text()}`).toBe(201);
    const body = await res.json();
    expect(body.applied).toBe(SAMPLE_LINES.length);
    expect(body.templateId).toBe(templateId);
    expect(body.quoteId).toBe(testQuoteId);
    expect(Number(body.totalAmount)).toBeGreaterThan(0);
  });

  test("POST /:id/apply twice → 409 ALREADY_HAS_LINES", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token || created.templateIds.length === 0 || !testQuoteId) {
      test.skip(true, "deps missing");
    }
    const templateId = created.templateIds[0];
    const res = await post(
      request,
      token,
      `/api/travel/quote-templates/${templateId}/apply`,
      { quoteId: testQuoteId },
    );
    expect(res.status()).toBe(409);
    const body = await res.json();
    expect(body.code).toBe("ALREADY_HAS_LINES");
    expect(body.existingLineCount).toBeGreaterThan(0);
  });

  test("POST /:id/apply missing quoteId → 400 INVALID_QUOTE_ID", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token || created.templateIds.length === 0) test.skip(true, "no template");
    const res = await post(
      request,
      token,
      `/api/travel/quote-templates/${created.templateIds[0]}/apply`,
      {},
    );
    expect(res.status()).toBe(400);
    expect((await res.json()).code).toBe("INVALID_QUOTE_ID");
  });

  test("POST /:id/apply unknown template → 404 QUOTE_TEMPLATE_NOT_FOUND", async ({
    request,
  }) => {
    const token = await getTravelAdmin(request);
    if (!token || !testQuoteId) test.skip(true, "deps missing");
    const res = await post(request, token, "/api/travel/quote-templates/9999999/apply", {
      quoteId: testQuoteId,
    });
    expect(res.status()).toBe(404);
    expect((await res.json()).code).toBe("QUOTE_TEMPLATE_NOT_FOUND");
  });

  test("POST /:id/apply unknown quote → 404 QUOTE_NOT_FOUND", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token || created.templateIds.length === 0) test.skip(true, "no template");
    const res = await post(
      request,
      token,
      `/api/travel/quote-templates/${created.templateIds[0]}/apply`,
      { quoteId: 9999999 },
    );
    expect(res.status()).toBe(404);
    expect((await res.json()).code).toBe("QUOTE_NOT_FOUND");
  });
});

// ─── Delete + RBAC ──────────────────────────────────────────────────

test.describe("Travel quote-templates API — delete + RBAC", () => {
  // Mint a fresh template so we can probe DELETE RBAC + happy delete
  // without losing the apply-flow target above.
  let deletableId = null;

  test.beforeAll(async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token) return;
    const r = await post(request, token, "/api/travel/quote-templates", {
      name: `${RUN_TAG} _teardown_ delete-target`,
      linesJson: JSON.stringify(SAMPLE_LINES),
    });
    if (r.ok()) {
      const body = await r.json();
      deletableId = body.id;
      created.templateIds.push(body.id);
    }
  });

  test("DELETE /:id as MANAGER → 403 (ADMIN-only soft-delete)", async ({ request }) => {
    const token = await getTravelManager(request);
    if (!token) test.skip(true, "rfu-advisor@travelstall.demo not seeded");
    if (!deletableId) test.skip(true, "deletable template missing");
    const res = await del(
      request,
      token,
      `/api/travel/quote-templates/${deletableId}`,
    );
    // verifyRole returns 403 to non-permitted roles.
    expect(res.status()).toBe(403);
  });

  test("DELETE /:id as ADMIN → 200 and the row is now isActive=false", async ({
    request,
  }) => {
    const token = await getTravelAdmin(request);
    if (!token || !deletableId) test.skip(true, "deps missing");
    const res = await del(request, token, `/api/travel/quote-templates/${deletableId}`);
    expect(res.status(), `delete: ${await res.text()}`).toBe(200);
    const body = await res.json();
    expect(body.isActive).toBe(false);
    expect(body.id).toBe(deletableId);

    // Verify via GET — the soft-deleted row stays queryable (it's only
    // hidden when ?isActive=true).
    const after = await get(
      request,
      token,
      `/api/travel/quote-templates/${deletableId}`,
    );
    expect(after.status()).toBe(200);
    expect((await after.json()).isActive).toBe(false);
  });
});
