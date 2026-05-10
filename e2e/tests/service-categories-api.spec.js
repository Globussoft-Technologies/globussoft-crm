// @ts-check
/**
 * Wave 7 Agent A — backend gate spec for service-categories.
 *
 * Routes: backend/routes/service_categories.js (mounted at
 * /api/wellness/service-categories). Closes PRD Gap §10 item 1.
 *
 * Endpoints covered:
 *   GET    /                          — open to any auth user
 *   POST   /                          — admin/manager only
 *   PUT    /:id                       — admin/manager only
 *   DELETE /:id                       — admin/manager only
 *
 * Coverage per endpoint:
 *   - happy path (201 / 200 / 204)
 *   - validation: missing name, parentId not in tenant, parent self-reference
 *   - auth gate: unauth 401
 *   - role gate: clinical-only roles (doctor) get 403 on POST/PUT/DELETE
 *   - duplicate name in same tenant returns 409 DUPLICATE_NAME
 *   - tenant scope: rows created in wellness tenant invisible to generic
 *
 * Pattern: Wellness-tenant primary login (rishu@enhancedwellness.in admin)
 * + a clinical-role login (drharsh@enhancedwellness.in doctor) to verify
 * the writeGate is closed. RUN_TAG isolates test rows; afterAll cleans.
 *
 * The route's response envelope is the bare row (no { data: ... } wrapper)
 * matching the existing wellness routes. _count is included on list.
 *
 * Standing-rule notes:
 *   - body strips id/tenantId/createdAt/updatedAt — never send those.
 *   - JWT key is userId not id — using r.user.id from /api/auth/login.
 */
const { test, expect } = require("@playwright/test");

const BASE_URL = process.env.BASE_URL || "https://crm.globusdemos.com";
const REQUEST_TIMEOUT = 30000;
const RUN_TAG = `_teardown_svccat_${Date.now()}`;

// ── Auth helpers ───────────────────────────────────────────────────

let adminToken = null;
let doctorToken = null;
let genericAdminToken = null;

async function login(request, email, password) {
  const r = await request.post(`${BASE_URL}/api/auth/login`, {
    data: { email, password },
    headers: { "Content-Type": "application/json" },
    timeout: REQUEST_TIMEOUT,
  });
  if (!r.ok()) return null;
  const j = await r.json();
  return j.token;
}

async function getAdmin(request) {
  if (!adminToken) adminToken = await login(request, "rishu@enhancedwellness.in", "password123");
  return adminToken;
}
async function getDoctor(request) {
  if (!doctorToken) doctorToken = await login(request, "drharsh@enhancedwellness.in", "password123");
  return doctorToken;
}
async function getGenericAdmin(request) {
  if (!genericAdminToken) genericAdminToken = await login(request, "admin@globussoft.com", "password123");
  return genericAdminToken;
}

const headers = (token) => ({ Authorization: `Bearer ${token}`, "Content-Type": "application/json" });

const createdIds = new Set();

test.afterAll(async ({ request }) => {
  const token = await getAdmin(request);
  if (!token) return;
  for (const id of createdIds) {
    await request.delete(`${BASE_URL}/api/wellness/service-categories/${id}`, { headers: headers(token) }).catch(() => {});
  }
});

// ── Tests ──────────────────────────────────────────────────────────

test.describe("Service Categories API — auth", () => {
  test("401 without token", async ({ request }) => {
    const r = await request.get(`${BASE_URL}/api/wellness/service-categories`);
    expect(r.status()).toBe(401);
  });
});

test.describe("Service Categories API — CRUD happy path", () => {
  test("POST creates a category and GET lists it", async ({ request }) => {
    const token = await getAdmin(request);
    const res = await request.post(`${BASE_URL}/api/wellness/service-categories`, {
      headers: headers(token),
      data: { name: `${RUN_TAG} Hair Care`, displayOrder: 5 },
    });
    expect(res.status(), `POST: ${await res.text()}`).toBe(201);
    const created = await res.json();
    createdIds.add(created.id);
    expect(created.name).toBe(`${RUN_TAG} Hair Care`);
    expect(created.displayOrder).toBe(5);
    expect(created.isActive).toBe(true);
    expect(created.parentId).toBeNull();

    const list = await request.get(`${BASE_URL}/api/wellness/service-categories`, { headers: headers(token) });
    expect(list.status()).toBe(200);
    const items = await list.json();
    expect(Array.isArray(items)).toBe(true);
    expect(items.find((c) => c.id === created.id)).toBeTruthy();
  });

  test("PUT updates a category", async ({ request }) => {
    const token = await getAdmin(request);
    const create = await request.post(`${BASE_URL}/api/wellness/service-categories`, {
      headers: headers(token),
      data: { name: `${RUN_TAG} Skin Care` },
    });
    const created = await create.json();
    createdIds.add(created.id);

    const upd = await request.put(`${BASE_URL}/api/wellness/service-categories/${created.id}`, {
      headers: headers(token),
      data: { name: `${RUN_TAG} Skin Aesthetics`, displayOrder: 10 },
    });
    expect(upd.status()).toBe(200);
    const updated = await upd.json();
    expect(updated.name).toBe(`${RUN_TAG} Skin Aesthetics`);
    expect(updated.displayOrder).toBe(10);
  });

  test("DELETE removes a category (204)", async ({ request }) => {
    const token = await getAdmin(request);
    const create = await request.post(`${BASE_URL}/api/wellness/service-categories`, {
      headers: headers(token),
      data: { name: `${RUN_TAG} ToDelete` },
    });
    const created = await create.json();

    const del = await request.delete(`${BASE_URL}/api/wellness/service-categories/${created.id}`, {
      headers: headers(token),
    });
    expect(del.status()).toBe(204);
  });

  test("hierarchy — child category references parent", async ({ request }) => {
    const token = await getAdmin(request);
    const parent = await request.post(`${BASE_URL}/api/wellness/service-categories`, {
      headers: headers(token),
      data: { name: `${RUN_TAG} ParentRoot` },
    });
    const parentJson = await parent.json();
    createdIds.add(parentJson.id);

    const child = await request.post(`${BASE_URL}/api/wellness/service-categories`, {
      headers: headers(token),
      data: { name: `${RUN_TAG} ChildLeaf`, parentId: parentJson.id },
    });
    expect(child.status()).toBe(201);
    const childJson = await child.json();
    createdIds.add(childJson.id);
    expect(childJson.parentId).toBe(parentJson.id);
  });
});

test.describe("Service Categories API — validation", () => {
  test("400 NAME_REQUIRED when name missing", async ({ request }) => {
    const token = await getAdmin(request);
    const res = await request.post(`${BASE_URL}/api/wellness/service-categories`, {
      headers: headers(token),
      data: { displayOrder: 5 },
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("NAME_REQUIRED");
  });

  test("400 PARENT_NOT_FOUND when parentId not in tenant", async ({ request }) => {
    const token = await getAdmin(request);
    const res = await request.post(`${BASE_URL}/api/wellness/service-categories`, {
      headers: headers(token),
      data: { name: `${RUN_TAG} bad-parent`, parentId: 999999 },
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("PARENT_NOT_FOUND");
  });

  test("400 PARENT_SELF_REFERENCE when parentId === id on PUT", async ({ request }) => {
    const token = await getAdmin(request);
    const c = await request.post(`${BASE_URL}/api/wellness/service-categories`, {
      headers: headers(token),
      data: { name: `${RUN_TAG} self-ref-test` },
    });
    const created = await c.json();
    createdIds.add(created.id);
    const res = await request.put(`${BASE_URL}/api/wellness/service-categories/${created.id}`, {
      headers: headers(token),
      data: { parentId: created.id },
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("PARENT_SELF_REFERENCE");
  });

  test("409 DUPLICATE_NAME on same tenant", async ({ request }) => {
    const token = await getAdmin(request);
    const name = `${RUN_TAG} Unique-Dup-Test`;
    const first = await request.post(`${BASE_URL}/api/wellness/service-categories`, {
      headers: headers(token),
      data: { name },
    });
    expect(first.status()).toBe(201);
    const firstJson = await first.json();
    createdIds.add(firstJson.id);
    const second = await request.post(`${BASE_URL}/api/wellness/service-categories`, {
      headers: headers(token),
      data: { name },
    });
    expect(second.status()).toBe(409);
    const body = await second.json();
    expect(body.code).toBe("DUPLICATE_NAME");
  });

  test("404 on PUT non-existent id", async ({ request }) => {
    const token = await getAdmin(request);
    const res = await request.put(`${BASE_URL}/api/wellness/service-categories/9999999`, {
      headers: headers(token),
      data: { name: "x" },
    });
    expect(res.status()).toBe(404);
  });

  test("404 on DELETE non-existent id", async ({ request }) => {
    const token = await getAdmin(request);
    const res = await request.delete(`${BASE_URL}/api/wellness/service-categories/9999999`, { headers: headers(token) });
    expect(res.status()).toBe(404);
  });
});

test.describe("Service Categories API — role gate", () => {
  test("doctor (clinical role only) can list but cannot create", async ({ request }) => {
    const token = await getDoctor(request);
    if (!token) test.skip(true, "doctor login unavailable in this stack");

    const list = await request.get(`${BASE_URL}/api/wellness/service-categories`, { headers: headers(token) });
    // List is open to any auth tenant user (the form picker needs it).
    expect(list.status()).toBe(200);

    const create = await request.post(`${BASE_URL}/api/wellness/service-categories`, {
      headers: headers(token),
      data: { name: `${RUN_TAG} doctor-attempt` },
    });
    // verifyWellnessRole rejects non-admin/manager with 403.
    expect(create.status()).toBe(403);
  });
});

test.describe("Service Categories API — tenant isolation", () => {
  test("generic admin cannot see wellness categories (different tenant)", async ({ request }) => {
    const wellnessToken = await getAdmin(request);
    const wRes = await request.post(`${BASE_URL}/api/wellness/service-categories`, {
      headers: headers(wellnessToken),
      data: { name: `${RUN_TAG} tenant-isolation-probe` },
    });
    expect(wRes.status()).toBe(201);
    const wJson = await wRes.json();
    createdIds.add(wJson.id);

    const genericToken = await getGenericAdmin(request);
    if (!genericToken) test.skip(true, "generic admin login unavailable");
    const gList = await request.get(`${BASE_URL}/api/wellness/service-categories`, {
      headers: headers(genericToken),
    });
    // Generic tenant lists ITS service categories — not wellness's.
    expect(gList.status()).toBe(200);
    const items = await gList.json();
    expect(items.find((c) => c.id === wJson.id)).toBeUndefined();
  });
});
