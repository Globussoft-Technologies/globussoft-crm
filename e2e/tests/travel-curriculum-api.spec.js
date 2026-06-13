// @ts-check
/**
 * Gate spec — TravelCurriculumMapping CRUD + CSV (PRD_TMC_CURRICULUM_MAPPING FR-10).
 *
 * G106 (docs/TRAVEL_GAP_CLOSURE_TRACKER.md §3.12) — adds the regression-coverage
 * gate spec for the curriculum-mapping surface. The route file
 * (backend/routes/travel_curriculum.js) has shipped + has unit tests at
 * backend/test/routes/travel_curriculum.test.js + sibling /stats / /by-month /
 * /by-quarter / /export.csv / /import.csv specs, but did NOT have a
 * deploy-gate spec until this commit. This file pins the live deployed contract.
 *
 * IMPORTANT — gap-card drift: the slice description named the route
 * `/api/travel/curriculum/mappings`. The actual route is mounted at
 * `/api/travel-curriculum` (sibling of `/api/embassy-rules`, NOT under the
 * `/api/travel/*` prefix). Pinning code reality per the
 * `verifying-gap-card-claims` standing rule.
 *
 * Covers:
 *   GET    /api/travel-curriculum               — list (auth required)
 *   GET    /api/travel-curriculum/:id           — single
 *   POST   /api/travel-curriculum               — create (ADMIN-only)
 *   GET    /api/travel-curriculum/export.csv    — CSV download (ADMIN+MANAGER)
 *   Cross-tenant 404 — a generic-tenant ADMIN must NOT see Travel tenant rows.
 *
 * RUN_TAG: every test-created row carries a unique tag in its `subject` /
 * `learningOutcome` field so afterAll teardown can sweep them without colliding
 * with seed data. Teardown is best-effort + capped at 40 seconds — the demo
 * box has 1-2 s round-trips, so a 5-row sweep finishes well inside the cap.
 */

const { test, expect } = require("@playwright/test");

test.describe.configure({ mode: "serial" });

const BASE_URL = process.env.BASE_URL || "https://crm.globusdemos.com";
const REQUEST_TIMEOUT = 60000;
const RUN_TAG = `E2E_TRAVEL_CURRICULUM_${Date.now()}`;

let travelAdminToken = null;
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
async function del(request, token, path) {
  return retryOn5xx(() =>
    request.delete(`${BASE_URL}${path}`, {
      headers: headers(token),
      timeout: REQUEST_TIMEOUT,
    }),
  );
}

const created = { mappingIds: [] };

test.afterAll(async ({ request }) => {
  const token = await getTravelAdmin(request);
  if (!token) return;
  const deadline = Date.now() + 40_000;
  for (const id of created.mappingIds) {
    if (Date.now() > deadline) break;
    // DELETE is soft-delete via isActive=false (route file lines 1223+).
    await del(request, token, `/api/travel-curriculum/${id}`).catch(() => {});
  }
});

test.describe("Travel curriculum API — auth gates", () => {
  test("GET / without auth → 401/403", async ({ request }) => {
    const res = await request.get(`${BASE_URL}/api/travel-curriculum`, {
      timeout: REQUEST_TIMEOUT,
    });
    expect([401, 403]).toContain(res.status());
  });
});

test.describe("Travel curriculum API — list + create", () => {
  test("GET /api/travel-curriculum returns a mappings array envelope", async ({ request }) => {
    const token = await getTravelAdmin(request);
    expect(token, "yasin@travelstall.in must be seeded").toBeTruthy();
    const res = await get(request, token, "/api/travel-curriculum");
    expect(res.status(), `list: ${await res.text()}`).toBe(200);
    const body = await res.json();
    // Route returns { mappings, total, limit, offset } per routes/travel_curriculum.js:177.
    expect(Array.isArray(body.mappings)).toBe(true);
    expect(typeof body.total).toBe("number");
    expect(typeof body.limit).toBe("number");
    expect(typeof body.offset).toBe("number");
  });

  test("POST creates a curriculum mapping with required fields", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token) test.skip(true, "no travel admin token");
    const res = await post(request, token, "/api/travel-curriculum", {
      curriculum: "CBSE",
      grade: "8",
      subject: `${RUN_TAG}_Geography`,
      learningOutcome: `${RUN_TAG}_understands_himalayan_rivers`,
      fitScore: 75,
      isActive: true,
    });
    expect(res.status(), `create: ${await res.text()}`).toBe(201);
    const body = await res.json();
    expect(body.id).toBeTruthy();
    expect(body.curriculum).toBe("CBSE");
    expect(body.grade).toBe("8");
    expect(body.fitScore).toBe(75);
    expect(body.isActive).toBe(true);
    created.mappingIds.push(body.id);
  });

  test("POST with missing required fields → 400 MISSING_FIELDS", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token) test.skip(true, "no travel admin token");
    const res = await post(request, token, "/api/travel-curriculum", {
      curriculum: "ICSE",
      // grade + subject missing
    });
    expect(res.status()).toBe(400);
    expect((await res.json()).code).toBe("MISSING_FIELDS");
  });

  test("POST with out-of-range fitScore → 400 INVALID_FIT_SCORE", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token) test.skip(true, "no travel admin token");
    const res = await post(request, token, "/api/travel-curriculum", {
      curriculum: "CBSE",
      grade: "10",
      subject: `${RUN_TAG}_BadScore`,
      fitScore: 9999,
    });
    expect(res.status()).toBe(400);
    expect((await res.json()).code).toBe("INVALID_FIT_SCORE");
  });
});

test.describe("Travel curriculum API — CSV export", () => {
  test("GET /export.csv returns text/csv attachment", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token) test.skip(true, "no travel admin token");
    const res = await get(request, token, "/api/travel-curriculum/export.csv");
    expect(res.status(), `export.csv: ${await res.text()}`).toBe(200);
    const ct = res.headers()["content-type"] || "";
    expect(ct).toMatch(/text\/csv/);
    const disposition = res.headers()["content-disposition"] || "";
    expect(disposition).toMatch(/attachment/);
    expect(disposition).toMatch(/curriculum-export-/);
    const body = await res.text();
    // CSV must contain a header line — the live serializer emits the
    // canonical column set. Avoid pinning the exact header bytes (the
    // serializeCurriculumCsv contract evolves with new columns); assert
    // structural shape instead.
    const firstLine = body.split(/\r?\n/)[0] || "";
    expect(firstLine.length).toBeGreaterThan(0);
    expect(firstLine).toMatch(/curriculum/i);
  });
});

test.describe("Travel curriculum API — cross-tenant isolation", () => {
  test("generic-tenant admin cannot see Travel-tenant rows via /:id", async ({ request }) => {
    if (created.mappingIds.length === 0) {
      test.skip(true, "no created row to probe against (POST happy path skipped)");
    }
    const id = created.mappingIds[0];
    const otherToken = await getGenericAdmin(request);
    if (!otherToken) test.skip(true, "admin@globussoft.com not seeded");
    const res = await get(request, otherToken, `/api/travel-curriculum/${id}`);
    // Either 404 CURRICULUM_NOT_FOUND (tenant filter hides the row) or 403
    // (a future vertical guard could 403 the entire surface). Both are
    // acceptable per the cross-tenant-isolation contract.
    expect([403, 404]).toContain(res.status());
    if (res.status() === 404) {
      expect((await res.json()).code).toBe("CURRICULUM_NOT_FOUND");
    }
  });

  test("non-numeric :id → 400 INVALID_ID", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token) test.skip(true, "no travel admin token");
    const res = await get(request, token, "/api/travel-curriculum/not-a-number");
    expect(res.status()).toBe(400);
    expect((await res.json()).code).toBe("INVALID_ID");
  });
});
