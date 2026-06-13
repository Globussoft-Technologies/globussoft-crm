// @ts-check
/**
 * Gate spec — Travel GST ledger endpoints (PRD_TRAVEL_GST_COMPLIANCE G030 + G031 + G032).
 *
 * Pins:
 *   GET /api/travel/invoices/customer-ledger?gstin=&fy=&contactId=&format=
 *   GET /api/travel/invoices/tds-register?fy=&section=&format=
 *   GET /api/travel/invoices/commission-ledger?fy=&type=&format=
 *
 * Standing rules (CLAUDE.md):
 *   - JWT key is userId, not id
 *   - Request bodies strip id/createdAt/updatedAt/tenantId/userId
 *   - afterAll teardown via _teardown_ prefix
 *   - RUN_TAG with timestamp suffix
 *
 * BASE_URL=http://127.0.0.1:5000 on per-push api_tests gate;
 * BASE_URL=https://crm.globusdemos.com on e2e-full release-validation.
 */

const { test, expect } = require("@playwright/test");

test.describe.configure({ mode: "serial" });

const BASE_URL = process.env.BASE_URL || "https://crm.globusdemos.com";
const REQUEST_TIMEOUT = 60000;
const RUN_TAG = `E2E_GST_LEDGERS_${Date.now()}`;

let travelAdminToken = null;

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

const created = { contactIds: [], invoiceIds: [], supplierIds: [], entryIds: [] };
const TEST_FY = "FY2026-27";

test.afterAll(async ({ request }) => {
  const token = await getTravelAdmin(request);
  if (!token) return;
  const deadline = Date.now() + 30_000;
  for (const id of created.invoiceIds) {
    if (Date.now() > deadline) break;
    await del(request, token, `/api/travel/invoices/${id}`).catch(() => {});
  }
  for (const id of created.contactIds) {
    if (Date.now() > deadline) break;
    await del(request, token, `/api/contacts/${id}`).catch(() => {});
  }
  for (const id of created.supplierIds) {
    if (Date.now() > deadline) break;
    await del(request, token, `/api/travel/suppliers/${id}`).catch(() => {});
  }
});

// ─── Guards ──────────────────────────────────────────────────────────

test.describe("Travel invoice ledgers — guards", () => {
  test("GET /customer-ledger without auth → 401/403", async ({ request }) => {
    const res = await request.get(
      `${BASE_URL}/api/travel/invoices/customer-ledger?fy=${TEST_FY}&contactId=1`,
      { timeout: REQUEST_TIMEOUT },
    );
    expect([401, 403]).toContain(res.status());
  });

  test("GET /tds-register without auth → 401/403", async ({ request }) => {
    const res = await request.get(`${BASE_URL}/api/travel/invoices/tds-register?fy=${TEST_FY}`, {
      timeout: REQUEST_TIMEOUT,
    });
    expect([401, 403]).toContain(res.status());
  });

  test("GET /commission-ledger without auth → 401/403", async ({ request }) => {
    const res = await request.get(
      `${BASE_URL}/api/travel/invoices/commission-ledger?fy=${TEST_FY}`,
      { timeout: REQUEST_TIMEOUT },
    );
    expect([401, 403]).toContain(res.status());
  });
});

// ─── /customer-ledger — G030 (FR-3.4.4) ──────────────────────────────

test.describe("Travel customer-ledger", () => {
  test("400 INVALID_FISCAL_YEAR on malformed fy", async ({ request }) => {
    const token = await getTravelAdmin(request);
    test.skip(!token, "no travel admin");
    const res = await get(
      request,
      token,
      `/api/travel/invoices/customer-ledger?fy=2025-26&contactId=1`,
    );
    expect(res.status()).toBe(400);
    expect((await res.json()).code).toBe("INVALID_FISCAL_YEAR");
  });

  test("400 MISSING_FILTER when neither gstin nor contactId given", async ({ request }) => {
    const token = await getTravelAdmin(request);
    test.skip(!token, "no travel admin");
    const res = await get(request, token, `/api/travel/invoices/customer-ledger?fy=${TEST_FY}`);
    expect(res.status()).toBe(400);
    expect((await res.json()).code).toBe("MISSING_FILTER");
  });

  test("400 INVALID_GSTIN on bad GSTIN shape", async ({ request }) => {
    const token = await getTravelAdmin(request);
    test.skip(!token, "no travel admin");
    const res = await get(
      request,
      token,
      `/api/travel/invoices/customer-ledger?fy=${TEST_FY}&gstin=notreal`,
    );
    expect(res.status()).toBe(400);
    expect((await res.json()).code).toBe("INVALID_GSTIN");
  });

  test("404 CONTACT_NOT_FOUND for unknown contactId", async ({ request }) => {
    const token = await getTravelAdmin(request);
    test.skip(!token, "no travel admin");
    const res = await get(
      request,
      token,
      `/api/travel/invoices/customer-ledger?fy=${TEST_FY}&contactId=99999999`,
    );
    expect(res.status()).toBe(404);
    expect((await res.json()).code).toBe("CONTACT_NOT_FOUND");
  });

  test("seed: create a Contact + a Draft TravelInvoice", async ({ request }) => {
    const token = await getTravelAdmin(request);
    test.skip(!token, "no travel admin");
    // 1) Contact
    const contactRes = await post(request, token, `/api/contacts`, {
      name: `_teardown_${RUN_TAG}_Ravi`,
      email: `ravi+${RUN_TAG}@example.com`,
      phone: "9999999999",
      status: "Customer",
    });
    if (contactRes.status() === 201 || contactRes.status() === 200) {
      const body = await contactRes.json();
      const id = body.id || body.contact?.id;
      if (id) created.contactIds.push(id);
    }
  });

  test("200 envelope shape with no transactions for a fresh contact", async ({ request }) => {
    const token = await getTravelAdmin(request);
    test.skip(!token || created.contactIds.length === 0, "no contact");
    const contactId = created.contactIds[0];
    const res = await get(
      request,
      token,
      `/api/travel/invoices/customer-ledger?fy=${TEST_FY}&contactId=${contactId}`,
    );
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.fiscalYear).toBe(TEST_FY);
    expect(body.contact).toBeDefined();
    expect(body.openingBalance).toBeDefined();
    expect(body.closingBalance).toBeDefined();
    expect(Array.isArray(body.transactions)).toBe(true);
    expect(body.summary).toMatchObject({
      totalInvoiced: expect.any(Number),
      totalPaid: expect.any(Number),
      totalOutstanding: expect.any(Number),
      invoiceCount: expect.any(Number),
      paymentCount: expect.any(Number),
    });
  });

  test("?format=csv returns text/csv with attachment header", async ({ request }) => {
    const token = await getTravelAdmin(request);
    test.skip(!token || created.contactIds.length === 0, "no contact");
    const contactId = created.contactIds[0];
    const res = await get(
      request,
      token,
      `/api/travel/invoices/customer-ledger?fy=${TEST_FY}&contactId=${contactId}&format=csv`,
    );
    expect(res.status()).toBe(200);
    const ct = res.headers()["content-type"];
    expect(ct).toMatch(/text\/csv/);
    const cd = res.headers()["content-disposition"];
    expect(cd).toMatch(/attachment.*\.csv/);
    const body = await res.text();
    expect(body).toContain("date,type,refNumber");
  });
});

// ─── /tds-register — G031 (FR-3.4.6) ─────────────────────────────────

test.describe("Travel TDS register", () => {
  test("400 INVALID_FISCAL_YEAR on malformed fy", async ({ request }) => {
    const token = await getTravelAdmin(request);
    test.skip(!token, "no travel admin");
    const res = await get(request, token, `/api/travel/invoices/tds-register?fy=2025-26`);
    expect(res.status()).toBe(400);
    expect((await res.json()).code).toBe("INVALID_FISCAL_YEAR");
  });

  test("400 INVALID_SECTION on unknown section", async ({ request }) => {
    const token = await getTravelAdmin(request);
    test.skip(!token, "no travel admin");
    const res = await get(
      request,
      token,
      `/api/travel/invoices/tds-register?fy=${TEST_FY}&section=194Z`,
    );
    expect(res.status()).toBe(400);
    expect((await res.json()).code).toBe("INVALID_SECTION");
  });

  test("200 envelope shape — section all, no entries", async ({ request }) => {
    const token = await getTravelAdmin(request);
    test.skip(!token, "no travel admin");
    const res = await get(request, token, `/api/travel/invoices/tds-register?fy=${TEST_FY}`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.fiscalYear).toBe(TEST_FY);
    expect(body.section).toBe("all");
    expect(Array.isArray(body.entries)).toBe(true);
    expect(body.summary).toMatchObject({
      totalDeducted: expect.any(Number),
      totalEntries: expect.any(Number),
    });
    expect(Array.isArray(body.summary.byDeductee)).toBe(true);
  });

  test("?section=194H narrows", async ({ request }) => {
    const token = await getTravelAdmin(request);
    test.skip(!token, "no travel admin");
    const res = await get(
      request,
      token,
      `/api/travel/invoices/tds-register?fy=${TEST_FY}&section=194H`,
    );
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.section).toBe("194H");
  });

  test("?format=csv returns text/csv with 26Q-style header", async ({ request }) => {
    const token = await getTravelAdmin(request);
    test.skip(!token, "no travel admin");
    const res = await get(
      request,
      token,
      `/api/travel/invoices/tds-register?fy=${TEST_FY}&format=csv`,
    );
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toMatch(/text\/csv/);
    const text = await res.text();
    expect(text).toContain("paymentDate,deducteeName,deducteePan");
  });
});

// ─── /commission-ledger — G032 (FR-3.4.7) ────────────────────────────

test.describe("Travel commission ledger", () => {
  test("400 INVALID_FISCAL_YEAR on malformed fy", async ({ request }) => {
    const token = await getTravelAdmin(request);
    test.skip(!token, "no travel admin");
    const res = await get(request, token, `/api/travel/invoices/commission-ledger?fy=bad`);
    expect(res.status()).toBe(400);
    expect((await res.json()).code).toBe("INVALID_FISCAL_YEAR");
  });

  test("400 INVALID_TYPE on unknown type", async ({ request }) => {
    const token = await getTravelAdmin(request);
    test.skip(!token, "no travel admin");
    const res = await get(
      request,
      token,
      `/api/travel/invoices/commission-ledger?fy=${TEST_FY}&type=wrongtype`,
    );
    expect(res.status()).toBe(400);
    expect((await res.json()).code).toBe("INVALID_TYPE");
  });

  test("200 envelope shape — type all, no entries", async ({ request }) => {
    const token = await getTravelAdmin(request);
    test.skip(!token, "no travel admin");
    const res = await get(request, token, `/api/travel/invoices/commission-ledger?fy=${TEST_FY}`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.fiscalYear).toBe(TEST_FY);
    expect(body.type).toBe("all");
    expect(Array.isArray(body.entries)).toBe(true);
    expect(body.summary).toMatchObject({
      totalAccrued: expect.any(Number),
      totalSettled: expect.any(Number),
      totalTds: expect.any(Number),
    });
    expect(Array.isArray(body.summary.bySupplier)).toBe(true);
  });

  test("?type=hotel narrows", async ({ request }) => {
    const token = await getTravelAdmin(request);
    test.skip(!token, "no travel admin");
    const res = await get(
      request,
      token,
      `/api/travel/invoices/commission-ledger?fy=${TEST_FY}&type=hotel`,
    );
    expect(res.status()).toBe(200);
    expect((await res.json()).type).toBe("hotel");
  });

  test("?format=csv returns text/csv with header row", async ({ request }) => {
    const token = await getTravelAdmin(request);
    test.skip(!token, "no travel admin");
    const res = await get(
      request,
      token,
      `/api/travel/invoices/commission-ledger?fy=${TEST_FY}&format=csv`,
    );
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toMatch(/text\/csv/);
    const text = await res.text();
    expect(text).toContain("date,supplierName,subBrand,category");
  });
});
