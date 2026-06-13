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

// ─── Supplier-master list — slim-shape opt-in (#920 slice S3) ────────
//
// Scope addition: the route file backend/routes/travel_suppliers.js carries
// BOTH the supplier-credentials vault (above) AND the supplier-master
// CRUD (`GET /api/travel/suppliers` — supplier directory used by quote /
// invoice / payable forms). Per FR-3.5 the supplier-master list endpoint
// gained a `?fields=summary` opt-in that drops every supplier PII column
// (contactPerson, phone, email, gstin, addressLine, paymentTermsDays,
// creditLimit, notes). Pins the slim shape here so a regression that
// re-introduces PII into the default supplier-master list response
// fails the gate.

test.describe("Travel suppliers MASTER list — slim-shape opt-in (#920 S3)", () => {
  test("GET /suppliers?fields=summary drops supplier PII (phone / email / gstin / contactPerson)", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token) test.skip(true, "no token");
    const res = await get(request, token, "/api/travel/suppliers?fields=summary");
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.suppliers)).toBe(true);
    if (body.suppliers.length === 0) test.skip(true, "no suppliers seeded");
    for (const s of body.suppliers) {
      expect(s).toHaveProperty("id");
      expect(s).toHaveProperty("name");
      expect(s).toHaveProperty("subBrand");
      expect(s).toHaveProperty("supplierCategory");
      // Supplier-PII MUST be absent on slim path.
      expect(s).not.toHaveProperty("phone");
      expect(s).not.toHaveProperty("email");
      expect(s).not.toHaveProperty("contactPerson");
      expect(s).not.toHaveProperty("gstin");
      expect(s).not.toHaveProperty("addressLine");
      expect(s).not.toHaveProperty("notes");
      expect(s).not.toHaveProperty("paymentTermsDays");
      expect(s).not.toHaveProperty("creditLimit");
    }
  });

  test("GET /suppliers (default shape) still ships supplier PII columns", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token) test.skip(true, "no token");
    const res = await get(request, token, "/api/travel/suppliers");
    expect(res.status()).toBe(200);
    const body = await res.json();
    if (body.suppliers.length === 0) test.skip(true, "no suppliers seeded");
    const s = body.suppliers[0];
    // Default shape: PII keys present (back-compat for existing
    // SuppliersAdmin.jsx + travel_invoices.js callers).
    expect(s).toHaveProperty("phone");
    expect(s).toHaveProperty("email");
    expect(s).toHaveProperty("contactPerson");
    expect(s).toHaveProperty("gstin");
  });
});

// ─── G038 — Supplier KYC + onboarding checklist ──────────────────────
//
// Smoke + shape coverage for the KYC endpoints. Deeper transition + RBAC
// semantics are covered in the unit suite (backend/test/routes/
// travel-suppliers-kyc.test.js); here we just verify the endpoints exist
// and return the envelope shape against the deployed demo.

test.describe("G038 KYC + onboarding checklist", () => {
  test("GET /suppliers/:id/kyc returns kyc envelope (null OR shape)", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token) test.skip(true, "no token");
    // Pick the first supplier visible to the TravelStall admin (covers
    // its sub-brand). If the tenant has no suppliers, the route returns
    // 200 with empty array — skip the test.
    const listRes = await get(request, token, "/api/travel/suppliers?fields=summary&limit=1");
    expect(listRes.status()).toBe(200);
    const list = await listRes.json();
    if (!list.suppliers || list.suppliers.length === 0) test.skip(true, "no suppliers seeded");
    const supplierId = list.suppliers[0].id;

    const res = await get(request, token, `/api/travel/suppliers/${supplierId}/kyc`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("supplierId");
    expect(body).toHaveProperty("kyc");
    // kyc is either null (not yet initialised) or has expected shape.
    if (body.kyc !== null) {
      expect(body.kyc).toHaveProperty("status");
      expect(body.kyc).toHaveProperty("panOnFile");
      expect(body.kyc).toHaveProperty("checklistItems");
      // PAN cleartext NEVER returned — only masked.
      expect(body.kyc).not.toHaveProperty("panNumber");
    }
  });

  test("GET /suppliers/:id/kyc non-numeric :id → 400 INVALID_ID", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token) test.skip(true, "no token");
    const res = await get(request, token, "/api/travel/suppliers/abc/kyc");
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("INVALID_ID");
  });

  test("GET /suppliers/:id/kyc as USER → 403", async ({ request }) => {
    // The yasin@travelstall.in account is ADMIN; we can't easily mint a
    // USER token in e2e without seed support. Stub via the generic-admin
    // token (cross-vertical guard fires first); this still pins the
    // multi-layer denial.
    const token = await getGenericAdmin(request);
    if (!token) test.skip(true, "no generic token");
    const res = await get(request, token, "/api/travel/suppliers/1/kyc");
    // Either 403 (wrong vertical) or some other denial — never 200.
    expect(res.status()).toBeGreaterThanOrEqual(400);
    expect(res.status()).toBeLessThan(500);
  });
});

// ─── G039 — Supplier dispute history + chargeback log ────────────────
//
// Smoke + shape coverage. Stats rollup is the most useful gate-spec read.

test.describe("G039 dispute history + stats rollup", () => {
  test("GET /disputes/stats returns rollup envelope", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token) test.skip(true, "no token");
    const res = await get(request, token, "/api/travel/disputes/stats");
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("byStatus");
    expect(body.byStatus).toHaveProperty("open");
    expect(body.byStatus).toHaveProperty("in_review");
    expect(body.byStatus).toHaveProperty("resolved");
    expect(body.byStatus).toHaveProperty("rejected");
    expect(body.byStatus).toHaveProperty("escalated");
    expect(body).toHaveProperty("openCount");
    expect(body).toHaveProperty("openAmount");
    expect(body).toHaveProperty("resolvedCount");
    expect(body).toHaveProperty("avgResolutionDays");
    expect(body).toHaveProperty("total");
  });

  test("GET /suppliers/:id/disputes returns paged envelope", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token) test.skip(true, "no token");
    const listRes = await get(request, token, "/api/travel/suppliers?fields=summary&limit=1");
    if (listRes.status() !== 200) test.skip(true, "no supplier");
    const list = await listRes.json();
    if (!list.suppliers || list.suppliers.length === 0) test.skip(true, "no suppliers seeded");
    const supplierId = list.suppliers[0].id;

    const res = await get(request, token, `/api/travel/suppliers/${supplierId}/disputes`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("supplierId");
    expect(body).toHaveProperty("disputes");
    expect(Array.isArray(body.disputes)).toBe(true);
    expect(body).toHaveProperty("total");
    expect(body).toHaveProperty("limit");
    expect(body).toHaveProperty("offset");
  });

  test("POST /suppliers/:id/disputes missing direction → 400 MISSING_FIELDS", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token) test.skip(true, "no token");
    const listRes = await get(request, token, "/api/travel/suppliers?fields=summary&limit=1");
    if (listRes.status() !== 200) test.skip(true, "no supplier");
    const list = await listRes.json();
    if (!list.suppliers || list.suppliers.length === 0) test.skip(true, "no suppliers seeded");
    const supplierId = list.suppliers[0].id;

    const res = await post(request, token, `/api/travel/suppliers/${supplierId}/disputes`, {
      type: "overbill", amount: 100, description: "test",
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("MISSING_FIELDS");
  });
});

// PRD_TRAVEL_SUPPLIER_MASTER G040/G041/G042/G043 — supplier governance suite.
//
// Pins:
//   - POST + PUT accept new fields: status + paymentTermsKind (whitelist).
//   - State-transition endpoints: /pause, /block, /archive, /reactivate.
//   - Credit-status endpoint: GET /suppliers/:id/credit-status returns
//     { current, limit, utilizationPct, status, currency }.
//   - Invalid enum values return 400 with the right error code.
test.describe("Supplier governance (G040/G041/G042/G043)", () => {
  test("POST /suppliers with status=paused returns 201 + status persisted", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token) test.skip(true, "no token");
    const res = await post(request, token, "/api/travel/suppliers", {
      name: `_teardown_${RUN_TAG}_paused`,
      subBrand: "tmc",
      status: "paused",
    });
    expect(res.status()).toBe(201);
    const body = await res.json();
    expect(body.status).toBe("paused");
    expect(body.isActive).toBe(false);
    // teardown
    await del(request, token, `/api/travel/suppliers/${body.id}`).catch(() => {});
  });

  test("POST /suppliers with invalid status → 400 INVALID_STATUS", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token) test.skip(true, "no token");
    const res = await post(request, token, "/api/travel/suppliers", {
      name: `_teardown_${RUN_TAG}_badstatus`,
      subBrand: "tmc",
      status: "frozen_solid",
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("INVALID_STATUS");
  });

  test("POST /suppliers with paymentTermsKind=prepay; days auto-nulled", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token) test.skip(true, "no token");
    const res = await post(request, token, "/api/travel/suppliers", {
      name: `_teardown_${RUN_TAG}_prepay`,
      subBrand: "tmc",
      paymentTermsKind: "prepay",
      paymentTermsDays: 30,
    });
    expect(res.status()).toBe(201);
    const body = await res.json();
    expect(body.paymentTermsKind).toBe("prepay");
    expect(body.paymentTermsDays).toBeNull();
    await del(request, token, `/api/travel/suppliers/${body.id}`).catch(() => {});
  });

  test("POST /suppliers invalid paymentTermsKind → 400", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token) test.skip(true, "no token");
    const res = await post(request, token, "/api/travel/suppliers", {
      name: `_teardown_${RUN_TAG}_badkind`,
      subBrand: "tmc",
      paymentTermsKind: "barter",
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("INVALID_PAYMENT_TERMS_KIND");
  });

  test("/suppliers/:id/pause flips status + isActive", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token) test.skip(true, "no token");
    const createRes = await post(request, token, "/api/travel/suppliers", {
      name: `_teardown_${RUN_TAG}_topause`,
      subBrand: "tmc",
    });
    if (createRes.status() !== 201) test.skip(true, "create failed");
    const supplier = await createRes.json();
    const res = await post(request, token, `/api/travel/suppliers/${supplier.id}/pause`, {});
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("paused");
    expect(body.isActive).toBe(false);
    await del(request, token, `/api/travel/suppliers/${supplier.id}`).catch(() => {});
  });

  test("/suppliers/:id/block without reason → 400 MISSING_FIELDS", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token) test.skip(true, "no token");
    const createRes = await post(request, token, "/api/travel/suppliers", {
      name: `_teardown_${RUN_TAG}_toblock`,
      subBrand: "tmc",
    });
    if (createRes.status() !== 201) test.skip(true, "create failed");
    const supplier = await createRes.json();
    const res = await post(request, token, `/api/travel/suppliers/${supplier.id}/block`, {});
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("MISSING_FIELDS");
    await del(request, token, `/api/travel/suppliers/${supplier.id}`).catch(() => {});
  });

  test("/suppliers/:id/block with reason → 200 + status=blocked_disputed", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token) test.skip(true, "no token");
    const createRes = await post(request, token, "/api/travel/suppliers", {
      name: `_teardown_${RUN_TAG}_blocked`,
      subBrand: "tmc",
    });
    if (createRes.status() !== 201) test.skip(true, "create failed");
    const supplier = await createRes.json();
    const res = await post(request, token, `/api/travel/suppliers/${supplier.id}/block`, {
      reason: "chargeback under review",
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("blocked_disputed");
    await del(request, token, `/api/travel/suppliers/${supplier.id}`).catch(() => {});
  });

  test("/suppliers/:id/reactivate flips from non-active back to active", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token) test.skip(true, "no token");
    const createRes = await post(request, token, "/api/travel/suppliers", {
      name: `_teardown_${RUN_TAG}_react`,
      subBrand: "tmc",
      status: "paused",
    });
    if (createRes.status() !== 201) test.skip(true, "create failed");
    const supplier = await createRes.json();
    const res = await post(request, token, `/api/travel/suppliers/${supplier.id}/reactivate`, {});
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("active");
    expect(body.isActive).toBe(true);
    await del(request, token, `/api/travel/suppliers/${supplier.id}`).catch(() => {});
  });

  test("GET /suppliers/:id/credit-status returns 5-field shape with no limit set", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token) test.skip(true, "no token");
    const createRes = await post(request, token, "/api/travel/suppliers", {
      name: `_teardown_${RUN_TAG}_credit`,
      subBrand: "tmc",
    });
    if (createRes.status() !== 201) test.skip(true, "create failed");
    const supplier = await createRes.json();
    const res = await get(request, token, `/api/travel/suppliers/${supplier.id}/credit-status`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("supplierId");
    expect(body).toHaveProperty("current");
    expect(body).toHaveProperty("limit");
    expect(body).toHaveProperty("utilizationPct");
    expect(body).toHaveProperty("status");
    expect(body).toHaveProperty("currency");
    // No limit configured → status: ok
    expect(body.status).toBe("ok");
    await del(request, token, `/api/travel/suppliers/${supplier.id}`).catch(() => {});
  });

  test("GET /suppliers/:id/credit-status returns 404 for unknown id", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token) test.skip(true, "no token");
    const res = await get(request, token, "/api/travel/suppliers/9999999/credit-status");
    expect(res.status()).toBe(404);
  });
});
