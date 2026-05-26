// @ts-check
/**
 * Gate spec — SupplierCredential vault.
 *
 * Pins the Day 9 commit. The vault stores airline / hotel / GDS / visa-
 * portal / payment-gateway login credentials with AES-256-GCM
 * encryption at rest (via lib/fieldEncryption.js).
 *
 * The CORE security invariant locked here: list + get-by-id
 * responses NEVER carry the encrypted blobs or their decrypted
 * plaintext. Only /:id/reveal returns the secrets, and that path
 * writes a SupplierCredentialAccessLog row.
 *
 * Covers:
 *   GET    /api/travel/supplier-credentials                  ADMIN+MANAGER
 *   POST   /api/travel/supplier-credentials                  ADMIN
 *   GET    /api/travel/supplier-credentials/:id              ADMIN+MANAGER
 *   POST   /api/travel/supplier-credentials/:id/reveal       ADMIN
 *   PATCH  /api/travel/supplier-credentials/:id              ADMIN
 *   DELETE /api/travel/supplier-credentials/:id              ADMIN
 *   GET    /api/travel/supplier-credentials/:id/access-log   ADMIN+MANAGER
 */

const { test, expect } = require("@playwright/test");

test.describe.configure({ mode: "serial" });

const BASE_URL = process.env.BASE_URL || "https://crm.globusdemos.com";
const REQUEST_TIMEOUT = 60000;
const RUN_TAG = `E2E_TRAVEL_SUP_${Date.now()}`;

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

async function get(request, token, path) {
  return retryOn5xx(() => request.get(`${BASE_URL}${path}`, { headers: headers(token), timeout: REQUEST_TIMEOUT }));
}
async function post(request, token, path, body) {
  return retryOn5xx(() => request.post(`${BASE_URL}${path}`, { headers: headers(token), data: body ?? {}, timeout: REQUEST_TIMEOUT }));
}
async function patch(request, token, path, body) {
  return retryOn5xx(() => request.patch(`${BASE_URL}${path}`, { headers: headers(token), data: body ?? {}, timeout: REQUEST_TIMEOUT }));
}
async function del(request, token, path) {
  return retryOn5xx(() => request.delete(`${BASE_URL}${path}`, { headers: headers(token), timeout: REQUEST_TIMEOUT }));
}

const created = { credIds: [] };

test.afterAll(async ({ request }) => {
  const token = await getTravelAdmin(request);
  if (!token) return;
  const deadline = Date.now() + 40_000;
  for (const id of created.credIds) {
    if (Date.now() > deadline) break;
    await del(request, token, `/api/travel/supplier-credentials/${id}`).catch(() => {});
  }
});

// ─── Guards ──────────────────────────────────────────────────────────

test.describe("Travel suppliers API — guards", () => {
  test("GET /supplier-credentials rejects generic admin with 403 WRONG_VERTICAL", async ({ request }) => {
    const token = await getGenericAdmin(request);
    if (!token) test.skip(true, "admin@globussoft.com not seeded");
    const res = await get(request, token, "/api/travel/supplier-credentials");
    expect(res.status()).toBe(403);
    expect((await res.json()).code).toBe("WRONG_VERTICAL");
  });

  test("GET /supplier-credentials without auth → 401/403", async ({ request }) => {
    const res = await request.get(`${BASE_URL}/api/travel/supplier-credentials`, { timeout: REQUEST_TIMEOUT });
    expect([401, 403]).toContain(res.status());
  });
});

// ─── CRUD + the cardinal "never leak" invariant ─────────────────────

test.describe("Travel suppliers API — vault create + read invariant", () => {
  test("POST creates a credential", async ({ request }) => {
    const token = await getTravelAdmin(request);
    expect(token, "yasin@travelstall.in must be seeded").toBeTruthy();
    const res = await post(request, token, "/api/travel/supplier-credentials", {
      category: "airline",
      supplierName: `${RUN_TAG} IndiGo Agent Portal`,
      loginId: "agent_e2e",
      password: "S3cret_Pa55w0rd_TestOnly",
      metadata: { mfa: "1234" },
    });
    expect(res.status(), `create: ${await res.text()}`).toBe(201);
    const body = await res.json();
    expect(body.id).toBeTruthy();
    expect(body.supplierName).toContain("IndiGo");
    // CRITICAL — encrypted blobs must NOT appear on the create response.
    expect(body.loginIdEncrypted).toBeUndefined();
    expect(body.passwordEncrypted).toBeUndefined();
    expect(body.loginId).toBeUndefined();
    expect(body.password).toBeUndefined();
    created.credIds.push(body.id);
  });

  test("POST with missing fields → 400 MISSING_FIELDS", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token) test.skip(true, "no token");
    const res = await post(request, token, "/api/travel/supplier-credentials", {
      category: "airline",
      // supplierName + loginId + password missing
    });
    expect(res.status()).toBe(400);
    expect((await res.json()).code).toBe("MISSING_FIELDS");
  });

  test("POST with bad category → 400 INVALID_CATEGORY", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token) test.skip(true, "no token");
    const res = await post(request, token, "/api/travel/supplier-credentials", {
      category: "spaceship",
      supplierName: "x",
      loginId: "x",
      password: "x",
    });
    expect(res.status()).toBe(400);
    expect((await res.json()).code).toBe("INVALID_CATEGORY");
  });

  test("GET /supplier-credentials list — NEVER returns encrypted blobs", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token || created.credIds.length === 0) test.skip(true, "no creds");
    const res = await get(request, token, "/api/travel/supplier-credentials");
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.credentials)).toBe(true);
    for (const c of body.credentials) {
      // Hard invariant — these columns MUST NOT escape via list.
      expect(c.loginIdEncrypted).toBeUndefined();
      expect(c.passwordEncrypted).toBeUndefined();
      expect(c.metadataJson).toBeUndefined();
    }
  });

  test("GET /supplier-credentials/:id — NEVER returns encrypted blobs", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token || created.credIds.length === 0) test.skip(true, "no creds");
    const res = await get(request, token, `/api/travel/supplier-credentials/${created.credIds[0]}`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.loginIdEncrypted).toBeUndefined();
    expect(body.passwordEncrypted).toBeUndefined();
    expect(body.metadataJson).toBeUndefined();
    expect(body.supplierName).toContain("IndiGo"); // metadata is fine
  });

  test("GET /:id unknown → 404 NOT_FOUND", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token) test.skip(true, "no token");
    const res = await get(request, token, "/api/travel/supplier-credentials/9999999");
    expect(res.status()).toBe(404);
    expect((await res.json()).code).toBe("NOT_FOUND");
  });
});

// ─── Reveal (the only decrypt path) ──────────────────────────────────

test.describe("Travel suppliers API — reveal + access log", () => {
  test("POST /:id/reveal returns plaintext + writes access-log", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token || created.credIds.length === 0) test.skip(true, "no creds");
    const id = created.credIds[0];
    const res = await post(request, token, `/api/travel/supplier-credentials/${id}/reveal`, {});
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.loginId).toBe("agent_e2e");
    expect(body.password).toBe("S3cret_Pa55w0rd_TestOnly");
    expect(body.metadata).toBeTruthy();

    // Verify the access-log row was written.
    const logRes = await get(request, token, `/api/travel/supplier-credentials/${id}/access-log`);
    expect(logRes.status()).toBe(200);
    const logBody = await logRes.json();
    expect(Array.isArray(logBody.accessLog)).toBe(true);
    expect(logBody.accessLog.length).toBeGreaterThanOrEqual(1);
    expect(logBody.accessLog[0].action).toBe("viewed");
  });

  test("POST /:id/reveal unknown id → 404 NOT_FOUND", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token) test.skip(true, "no token");
    const res = await post(request, token, "/api/travel/supplier-credentials/9999999/reveal", {});
    expect(res.status()).toBe(404);
    expect((await res.json()).code).toBe("NOT_FOUND");
  });
});

// ─── Rotate + delete ─────────────────────────────────────────────────

test.describe("Travel suppliers API — rotate + delete", () => {
  test("PATCH rotates password + writes \"rotated\" access-log", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token || created.credIds.length === 0) test.skip(true, "no creds");
    const id = created.credIds[0];
    const res = await patch(request, token, `/api/travel/supplier-credentials/${id}`, {
      password: "NewR0tated_Pa55w0rd",
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.passwordEncrypted).toBeUndefined(); // metadata projection only

    // Reveal again → should show the new password
    const revealRes = await post(request, token, `/api/travel/supplier-credentials/${id}/reveal`, {});
    expect(revealRes.status()).toBe(200);
    expect((await revealRes.json()).password).toBe("NewR0tated_Pa55w0rd");

    // Access-log should now contain a "rotated" + 2x "viewed" entries.
    const logRes = await get(request, token, `/api/travel/supplier-credentials/${id}/access-log`);
    const actions = (await logRes.json()).accessLog.map((r) => r.action);
    expect(actions).toContain("rotated");
  });

  test("PATCH metadata-only doesn't write a \"rotated\" log entry (no secret rotated)", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token || created.credIds.length === 0) test.skip(true, "no creds");
    const id = created.credIds[0];
    const before = await get(request, token, `/api/travel/supplier-credentials/${id}/access-log`);
    const beforeRotated = (await before.json()).accessLog.filter((r) => r.action === "rotated").length;
    const res = await patch(request, token, `/api/travel/supplier-credentials/${id}`, {
      supplierName: `${RUN_TAG} IndiGo Updated Name`,
    });
    expect(res.status()).toBe(200);
    const after = await get(request, token, `/api/travel/supplier-credentials/${id}/access-log`);
    const afterRotated = (await after.json()).accessLog.filter((r) => r.action === "rotated").length;
    expect(afterRotated).toBe(beforeRotated);
  });

  test("PATCH empty body → 400 EMPTY_BODY", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token || created.credIds.length === 0) test.skip(true, "no creds");
    const res = await patch(request, token, `/api/travel/supplier-credentials/${created.credIds[0]}`, {});
    expect(res.status()).toBe(400);
    expect((await res.json()).code).toBe("EMPTY_BODY");
  });
});
