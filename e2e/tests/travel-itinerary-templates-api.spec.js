// @ts-check
/**
 * Gate spec — Travel itinerary templates (G048 / G050 / G058 lifecycle).
 *
 * Pins the second-tier itinerary template features per
 * docs/PRD_TRAVEL_ITINERARY_UPGRADES.md §3.5 + §3.1.f:
 *   - G048 Template versioning + archive/restore (FR-3.5.a, FR-3.5.b)
 *   - G050 Save current itinerary as template (FR-3.1.f)
 *   - G058 Template analytics CSV export (FR-3.5.c)
 *
 * Endpoint contract pinned:
 *   GET    /api/travel/itinerary-templates              (default + ?includeArchived + ?includeAllVersions)
 *   POST   /api/travel/itinerary-templates              (create)
 *   PATCH  /api/travel/itinerary-templates/:id          (G048 version-on-edit — creates NEW row)
 *   POST   /api/travel/itinerary-templates/:id/archive  (G048 sets archivedAt)
 *   POST   /api/travel/itinerary-templates/:id/restore  (G048 clears archivedAt)
 *   GET    /api/travel/itinerary-templates/analytics.csv (G058)
 *   POST   /api/travel/itineraries/:id/save-as-template (G050)
 *
 * Auth: yasin@travelstall.in (travel ADMIN, seeded by seed-travel.js).
 *
 * Cleanup: RUN_TAG is embedded in template names; afterAll archives + soft-
 * deletes every created template. Itinerary used for save-as-template gets
 * a real cleanup via DELETE.
 */

const { test, expect } = require("@playwright/test");

test.describe.configure({ mode: "serial" });

const BASE_URL = process.env.BASE_URL || "https://crm.globusdemos.com";
const REQUEST_TIMEOUT = 60000;
const RUN_TAG = `E2E_TRAVEL_TPL_${Date.now()}`;

let travelAdminToken = null;
const created = { templateIds: [], itineraryIds: [], contactId: null };

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
    request.get(`${BASE_URL}${path}`, { headers: headers(token), timeout: REQUEST_TIMEOUT }),
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
    request.delete(`${BASE_URL}${path}`, { headers: headers(token), timeout: REQUEST_TIMEOUT }),
  );
}

test.beforeAll(async ({ request }) => {
  const token = await getTravelAdmin(request);
  if (!token) return;
  // Spec needs a Contact for save-as-template's source itinerary. Tagged
  // with RUN_TAG so demo-scrub can sweep it.
  const r = await post(request, token, "/api/contacts", {
    name: `${RUN_TAG} Template Test Contact`,
    email: `${RUN_TAG.toLowerCase()}@e2e.test`,
    phone: `+91${String(Date.now()).slice(-10)}`,
    subBrand: "rfu",
  });
  if (r.ok()) {
    const body = await r.json();
    created.contactId = body.id || body.contact?.id;
  }
  // Submit a diagnostic so /itineraries POST will succeed (diagnostic-first
  // guard per PRD §4.1).
  if (created.contactId) {
    const banksRes = await get(
      request,
      token,
      "/api/travel/diagnostic-banks?subBrand=rfu&active=true",
    );
    if (banksRes.ok()) {
      const banks = (await banksRes.json()).banks || [];
      const rfuBank = banks.find((b) => b.subBrand === "rfu");
      if (rfuBank) {
        await post(request, token, "/api/travel/diagnostics", {
          bankId: rfuBank.id,
          answers: { q1: "few", q2: "medium" },
          contactId: created.contactId,
        }).catch(() => null);
      }
    }
  }
});

test.afterAll(async ({ request }) => {
  const token = await getTravelAdmin(request);
  if (!token) return;
  const deadline = Date.now() + 40_000;
  // Templates: soft-delete (DELETE handler flips isActive=false). Archived
  // siblings get the same treatment.
  for (const id of created.templateIds) {
    if (Date.now() > deadline) break;
    await del(request, token, `/api/travel/itinerary-templates/${id}`).catch(() => {});
  }
  for (const id of created.itineraryIds) {
    if (Date.now() > deadline) break;
    await del(request, token, `/api/travel/itineraries/${id}`).catch(() => {});
  }
  if (created.contactId) {
    await del(request, token, `/api/contacts/${created.contactId}`).catch(() => {});
  }
});

// ─── G048 — version-on-edit round-trip ──────────────────────────────

test.describe("G048 — template versioning", () => {
  let v1Id = null;
  let v2Id = null;

  test("POST creates v1 (version=1, isLatest=true, archivedAt=null)", async ({ request }) => {
    const token = await getTravelAdmin(request);
    expect(token).toBeTruthy();
    const res = await post(request, token, "/api/travel/itinerary-templates", {
      name: `${RUN_TAG} Versioning Test`,
      destinationName: "Paris",
      durationDays: 5,
      subBrand: "rfu",
      category: "City Break",
      currency: "INR",
      basePriceMinor: 8500000,
    });
    expect(res.status(), `create: ${await res.text()}`).toBe(201);
    const body = await res.json();
    expect(body.id).toBeTruthy();
    expect(body.version).toBe(1);
    expect(body.isLatest).toBe(true);
    expect(body.archivedAt).toBeNull();
    v1Id = body.id;
    created.templateIds.push(v1Id);
  });

  test("PATCH bumps version → returns NEW row at version=2 with fresh id", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!v1Id) test.skip(true, "v1 not created");
    const res = await patch(
      request,
      token,
      `/api/travel/itinerary-templates/${v1Id}`,
      { durationDays: 7, description: "Updated to 7-day plan" },
    );
    expect(res.status(), `patch: ${await res.text()}`).toBe(200);
    const body = await res.json();
    expect(body.version).toBe(2);
    expect(body.isLatest).toBe(true);
    expect(body.durationDays).toBe(7);
    expect(body.id).not.toBe(v1Id); // fresh id, not v1's id
    v2Id = body.id;
    created.templateIds.push(v2Id);
  });

  test("Prior version stays queryable by id (history preserved)", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!v1Id) test.skip(true, "v1 not created");
    const res = await get(request, token, `/api/travel/itinerary-templates/${v1Id}`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.id).toBe(v1Id);
    expect(body.version).toBe(1);
    expect(body.isLatest).toBe(false); // flipped on edit
    expect(body.durationDays).toBe(5); // historical value preserved
  });

  test("Default list shows only v2 (latest), not v1", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!v1Id || !v2Id) test.skip(true, "versions not created");
    const res = await get(
      request,
      token,
      `/api/travel/itinerary-templates?destinationName=Paris&limit=200`,
    );
    expect(res.status()).toBe(200);
    const body = await res.json();
    const ids = (body.items || []).map((it) => it.id);
    expect(ids).toContain(v2Id);
    expect(ids).not.toContain(v1Id);
  });

  test("?includeAllVersions=true surfaces v1 alongside v2", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!v1Id || !v2Id) test.skip(true, "versions not created");
    const res = await get(
      request,
      token,
      `/api/travel/itinerary-templates?destinationName=Paris&includeAllVersions=true&limit=200`,
    );
    expect(res.status()).toBe(200);
    const body = await res.json();
    const ids = (body.items || []).map((it) => it.id);
    expect(ids).toContain(v1Id);
    expect(ids).toContain(v2Id);
  });
});

// ─── G048 — archive/restore round-trip ──────────────────────────────

test.describe("G048 — archive + restore", () => {
  let archiveId = null;

  test("POST creates a template to archive", async ({ request }) => {
    const token = await getTravelAdmin(request);
    const res = await post(request, token, "/api/travel/itinerary-templates", {
      name: `${RUN_TAG} Archive Test`,
      destinationName: "Goa",
      durationDays: 4,
      subBrand: "rfu",
    });
    expect(res.status()).toBe(201);
    archiveId = (await res.json()).id;
    created.templateIds.push(archiveId);
  });

  test("POST /:id/archive sets archivedAt → row hidden from default list", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!archiveId) test.skip(true, "no archive target");
    const archiveRes = await post(
      request,
      token,
      `/api/travel/itinerary-templates/${archiveId}/archive`,
    );
    expect(archiveRes.status()).toBe(200);
    const body = await archiveRes.json();
    expect(body.archivedAt).toBeTruthy();

    // Default list excludes archived row.
    const listRes = await get(
      request,
      token,
      `/api/travel/itinerary-templates?destinationName=Goa&limit=200`,
    );
    expect(listRes.status()).toBe(200);
    const ids = ((await listRes.json()).items || []).map((it) => it.id);
    expect(ids).not.toContain(archiveId);
  });

  test("?includeArchived=true surfaces the archived row", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!archiveId) test.skip(true, "no archive target");
    const res = await get(
      request,
      token,
      `/api/travel/itinerary-templates?destinationName=Goa&includeArchived=true&limit=200`,
    );
    expect(res.status()).toBe(200);
    const ids = ((await res.json()).items || []).map((it) => it.id);
    expect(ids).toContain(archiveId);
  });

  test("POST /:id/restore clears archivedAt → row returns to default list", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!archiveId) test.skip(true, "no archive target");
    const restoreRes = await post(
      request,
      token,
      `/api/travel/itinerary-templates/${archiveId}/restore`,
    );
    expect(restoreRes.status()).toBe(200);
    const body = await restoreRes.json();
    expect(body.archivedAt).toBeNull();

    const listRes = await get(
      request,
      token,
      `/api/travel/itinerary-templates?destinationName=Goa&limit=200`,
    );
    expect(listRes.status()).toBe(200);
    const ids = ((await listRes.json()).items || []).map((it) => it.id);
    expect(ids).toContain(archiveId);
  });
});

// ─── G050 — save-as-template ────────────────────────────────────────

test.describe("G050 — save-as-template", () => {
  let sourceItineraryId = null;
  let savedTemplateId = null;

  test("Create source itinerary + items", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!created.contactId) test.skip(true, "no test contact");
    const res = await post(request, token, "/api/travel/itineraries", {
      subBrand: "rfu",
      contactId: created.contactId,
      destination: `${RUN_TAG} Source for Template`,
      startDate: "2026-08-01",
      endDate: "2026-08-05",
      totalAmount: 95000,
      currency: "INR",
      items: [
        { itemType: "flight", description: "BLR-JED", unitCost: 35000 },
        { itemType: "hotel", description: "Haram view 4n", unitCost: 60000 },
      ],
    });
    expect(res.status(), `create source: ${await res.text()}`).toBe(201);
    sourceItineraryId = (await res.json()).id;
    created.itineraryIds.push(sourceItineraryId);
  });

  test("POST /itineraries/:id/save-as-template creates a new template", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!sourceItineraryId) test.skip(true, "no source itinerary");
    const res = await post(
      request,
      token,
      `/api/travel/itineraries/${sourceItineraryId}/save-as-template`,
      { name: `${RUN_TAG} Saved Template` },
    );
    expect(res.status(), `save-as-template: ${await res.text()}`).toBe(201);
    const body = await res.json();
    expect(body.id).toBeTruthy();
    expect(body.name).toContain(RUN_TAG);
    expect(body.subBrand).toBe("rfu");
    expect(body.version).toBe(1);
    expect(body.isLatest).toBe(true);
    // basePriceMinor derived from totalAmount (95000 * 100 = 9500000)
    expect(body.basePriceMinor).toBe(9500000);
    savedTemplateId = body.id;
    created.templateIds.push(savedTemplateId);
  });
});

// ─── G058 — analytics CSV export ────────────────────────────────────

test.describe("G058 — analytics.csv export", () => {
  test("GET /analytics.csv returns text/csv with canonical header", async ({ request }) => {
    const token = await getTravelAdmin(request);
    const res = await get(
      request,
      token,
      "/api/travel/itinerary-templates/analytics.csv",
    );
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toMatch(/text\/csv/);
    expect(res.headers()["content-disposition"]).toMatch(
      /attachment; filename="itinerary-template-analytics\.csv"/,
    );
    const body = await res.text();
    const firstLine = body.split("\n")[0];
    expect(firstLine).toBe(
      "id,name,subBrand,usageCount,acceptedCount,avgFinalPrice,lastUsedAt,createdAt,version,isLatest",
    );
  });
});
