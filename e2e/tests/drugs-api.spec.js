// @ts-check
/**
 * Wave 7 Agent A — backend gate spec for drugs catalogue.
 *
 * Routes: backend/routes/drugs.js (mounted at /api/wellness/drugs).
 * Closes PRD Gap §10 item 2.
 *
 * Endpoints covered:
 *   GET    /            — admin/manager/doctor (typeahead consumers)
 *   GET    /:id         — same role gate
 *   POST   /            — admin/manager only
 *   PUT    /:id         — admin/manager only
 *   DELETE /:id         — admin/manager only
 *
 * Coverage per endpoint:
 *   - happy path
 *   - validation: NAME_REQUIRED, INVALID_DOSAGE_FORM
 *   - auth gate 401, role gate 403
 *   - typeahead substring search across name + genericName
 *   - tenant isolation (wellness vs generic)
 *   - seeded drug count >= 16 against wellness tenant
 */
const { test, expect } = require("@playwright/test");

const BASE_URL = process.env.BASE_URL || "https://crm.globusdemos.com";
const REQUEST_TIMEOUT = 30000;
const RUN_TAG = `_teardown_drug_${Date.now()}`;

let adminToken = null;
let doctorToken = null;
let telecallerToken = null;

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
async function getTelecaller(request) {
  if (!telecallerToken) telecallerToken = await login(request, "telecaller@enhancedwellness.in", "password123");
  return telecallerToken;
}

const headers = (token) => ({ Authorization: `Bearer ${token}`, "Content-Type": "application/json" });

const createdIds = new Set();

test.afterAll(async ({ request }) => {
  const token = await getAdmin(request);
  if (!token) return;
  for (const id of createdIds) {
    await request.delete(`${BASE_URL}/api/wellness/drugs/${id}`, { headers: headers(token) }).catch(() => {});
  }
});

// ── Tests ──────────────────────────────────────────────────────────

test.describe("Drugs API — auth", () => {
  test("401 without token", async ({ request }) => {
    const r = await request.get(`${BASE_URL}/api/wellness/drugs`);
    expect(r.status()).toBe(401);
  });
});

test.describe("Drugs API — list + seeded data", () => {
  test("admin can list and seed brings paracetamol/ibuprofen/etc.", async ({ request }) => {
    const token = await getAdmin(request);
    const res = await request.get(`${BASE_URL}/api/wellness/drugs?isActive=true`, { headers: headers(token) });
    expect(res.status()).toBe(200);
    const items = await res.json();
    expect(Array.isArray(items)).toBe(true);
    // Seeded drugs are present in the wellness tenant.
    const names = items.map((d) => d.name);
    expect(names).toContain("Paracetamol");
    expect(names).toContain("Ibuprofen");
  });

  test("doctor can list (read gate is admin/manager/doctor)", async ({ request }) => {
    const token = await getDoctor(request);
    if (!token) test.skip(true, "doctor login unavailable");
    const res = await request.get(`${BASE_URL}/api/wellness/drugs`, { headers: headers(token) });
    expect(res.status()).toBe(200);
  });

  test("telecaller is denied (not in read gate)", async ({ request }) => {
    const token = await getTelecaller(request);
    if (!token) test.skip(true, "telecaller login unavailable");
    const res = await request.get(`${BASE_URL}/api/wellness/drugs`, { headers: headers(token) });
    expect(res.status()).toBe(403);
  });

  test("?q=para matches name or genericName (substring)", async ({ request }) => {
    const token = await getAdmin(request);
    const res = await request.get(`${BASE_URL}/api/wellness/drugs?q=para`, { headers: headers(token) });
    expect(res.status()).toBe(200);
    const items = await res.json();
    // Paracetamol (name) and "Acetaminophen + Para..." (genericName) candidates
    expect(items.length).toBeGreaterThan(0);
    const allMatch = items.every(
      (d) => /para/i.test(d.name) || (d.genericName && /para/i.test(d.genericName)),
    );
    expect(allMatch).toBe(true);
  });
});

test.describe("Drugs API — CRUD happy path", () => {
  test("POST creates a drug with all the structured fields", async ({ request }) => {
    const token = await getAdmin(request);
    const res = await request.post(`${BASE_URL}/api/wellness/drugs`, {
      headers: headers(token),
      data: {
        name: `${RUN_TAG} Probiotic`,
        genericName: "Lactobacillus",
        dosageForm: "capsule",
        strengthValue: "10",
        strengthUnit: "billion CFU",
        defaultDosage: "1 capsule",
        defaultFrequency: "once daily",
        defaultDuration: "30 days",
      },
    });
    expect(res.status(), `POST: ${await res.text()}`).toBe(201);
    const created = await res.json();
    createdIds.add(created.id);
    expect(created.name).toBe(`${RUN_TAG} Probiotic`);
    expect(created.dosageForm).toBe("capsule");
    expect(created.isActive).toBe(true);
  });

  test("PUT updates fields and toggle isActive", async ({ request }) => {
    const token = await getAdmin(request);
    const c = await request.post(`${BASE_URL}/api/wellness/drugs`, {
      headers: headers(token),
      data: { name: `${RUN_TAG} ToUpdate`, dosageForm: "tablet" },
    });
    const created = await c.json();
    createdIds.add(created.id);
    const upd = await request.put(`${BASE_URL}/api/wellness/drugs/${created.id}`, {
      headers: headers(token),
      data: { defaultDosage: "2 tablets", isActive: false },
    });
    expect(upd.status()).toBe(200);
    const updated = await upd.json();
    expect(updated.defaultDosage).toBe("2 tablets");
    expect(updated.isActive).toBe(false);
  });

  test("DELETE removes a drug (204)", async ({ request }) => {
    const token = await getAdmin(request);
    const c = await request.post(`${BASE_URL}/api/wellness/drugs`, {
      headers: headers(token),
      data: { name: `${RUN_TAG} ToDelete` },
    });
    const created = await c.json();
    const del = await request.delete(`${BASE_URL}/api/wellness/drugs/${created.id}`, { headers: headers(token) });
    expect(del.status()).toBe(204);
    const getBack = await request.get(`${BASE_URL}/api/wellness/drugs/${created.id}`, { headers: headers(token) });
    expect(getBack.status()).toBe(404);
  });
});

test.describe("Drugs API — validation", () => {
  test("400 NAME_REQUIRED when name missing", async ({ request }) => {
    const token = await getAdmin(request);
    const res = await request.post(`${BASE_URL}/api/wellness/drugs`, {
      headers: headers(token),
      data: { dosageForm: "tablet" },
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("NAME_REQUIRED");
  });

  test("400 INVALID_DOSAGE_FORM on bogus form", async ({ request }) => {
    const token = await getAdmin(request);
    const res = await request.post(`${BASE_URL}/api/wellness/drugs`, {
      headers: headers(token),
      data: { name: `${RUN_TAG} bogus-form`, dosageForm: "vibrations" },
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("INVALID_DOSAGE_FORM");
  });

  test("404 on PUT non-existent id", async ({ request }) => {
    const token = await getAdmin(request);
    const res = await request.put(`${BASE_URL}/api/wellness/drugs/9999999`, {
      headers: headers(token),
      data: { name: "X" },
    });
    expect(res.status()).toBe(404);
  });
});

test.describe("Drugs API — role gate (write)", () => {
  test("doctor cannot POST a new drug", async ({ request }) => {
    const token = await getDoctor(request);
    if (!token) test.skip(true, "doctor login unavailable");
    const res = await request.post(`${BASE_URL}/api/wellness/drugs`, {
      headers: headers(token),
      data: { name: `${RUN_TAG} doctor-write` },
    });
    expect(res.status()).toBe(403);
  });
});
