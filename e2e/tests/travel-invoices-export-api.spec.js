// @ts-check
/**
 * Gate spec — Travel-invoice CA / Tally exporters (TRAVEL_CRM_PRD §4.4,
 * gap A2 — docs/TRAVEL_PRD_GAP_ANALYSIS_2026-06-12.md).
 *
 * Routes: backend/routes/travel_invoices.js
 *   GET /api/travel/invoices/export/tally.xml?from=&to=&subBrand=
 *   GET /api/travel/invoices/export/ca.csv?from=&to=&subBrand=
 * File builders: backend/lib/travelAccountingExport.js (pure — unit-tested
 * in backend/test/lib/travelAccountingExport.test.js; this spec pins the
 * HTTP contract only).
 *
 * Pins:
 *   - Auth gate (401/403 without token)
 *   - Role gate (travel USER → 403; finance surface is ADMIN/MANAGER only)
 *   - Vertical gate (generic admin → 403 WRONG_VERTICAL)
 *   - Happy path: 200 + Content-Type (application/xml / text/csv) +
 *     Content-Disposition attachment + body sniff (<ENVELOPE> / pinned
 *     CSV header row)
 *   - 400 INVALID_DATE_RANGE on garbage ?from
 *   - 400 INVALID_SUB_BRAND on unknown ?subBrand
 *
 * Deliberately NOT pinned: row counts / amounts (demo seed drift would
 * red-line those routinely). The Voided-exclusion + GST-math behaviour is
 * deterministic at the unit layer.
 *
 * Auth deps (same seed accounts as travel-visa-analytics-api.spec.js):
 *   yasin@travelstall.in          (travel ADMIN, seed-travel.js)
 *   telecaller@travelstall.demo   (travel USER — role-gate 403)
 *   admin@globussoft.com          (generic ADMIN — WRONG_VERTICAL guard)
 *
 * Read-only spec — no rows created, no afterAll cleanup needed.
 */

const { test, expect } = require("@playwright/test");

test.describe.configure({ mode: "serial" });

const BASE_URL = process.env.BASE_URL || "https://crm.globusdemos.com";
const REQUEST_TIMEOUT = 60000;

let travelAdminToken = null;
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

// Cloudflare-fronted demo occasionally surfaces transient 5xx during origin
// restarts; retry those with a short backoff. 4xx bails immediately so
// genuine RBAC/validator regressions still surface.
async function retryOn5xx(fn) {
  let r;
  for (let attempt = 0; attempt < 3; attempt++) {
    r = await fn();
    if (r.status() < 500) return r;
    await new Promise((res) => setTimeout(res, 500 * (attempt + 1)));
  }
  return r;
}

function get(request, token, path) {
  return retryOn5xx(() =>
    request.get(`${BASE_URL}${path}`, {
      headers: token ? headers(token) : undefined,
      timeout: REQUEST_TIMEOUT,
    }),
  );
}

const TALLY_PATH = "/api/travel/invoices/export/tally.xml";
const CSV_PATH = "/api/travel/invoices/export/ca.csv";

// ─── Guards ─────────────────────────────────────────────────────────

test.describe("Travel invoice exports — guards", () => {
  for (const path of [TALLY_PATH, CSV_PATH]) {
    test(`GET ${path} without token → 401/403`, async ({ request }) => {
      const r = await get(request, null, path);
      expect([401, 403]).toContain(r.status());
    });

    test(`GET ${path} as travel USER role → 403`, async ({ request }) => {
      const token = await getTravelUser(request);
      if (!token) {
        test.skip(true, "telecaller@travelstall.demo not seeded — skipping USER-RBAC test");
        return;
      }
      const r = await get(request, token, path);
      expect(r.status()).toBe(403);
    });

    test(`GET ${path} as generic admin → 403 WRONG_VERTICAL`, async ({ request }) => {
      const token = await getGenericAdmin(request);
      if (!token) {
        test.skip(true, "generic admin login unavailable");
        return;
      }
      const r = await get(request, token, path);
      expect(r.status()).toBe(403);
      expect((await r.json()).code).toBe("WRONG_VERTICAL");
    });
  }
});

// ─── Validation ─────────────────────────────────────────────────────

test.describe("Travel invoice exports — validation", () => {
  test("garbage ?from → 400 INVALID_DATE_RANGE (tally.xml)", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token) {
      test.skip(true, "travel admin login unavailable");
      return;
    }
    const r = await get(request, token, `${TALLY_PATH}?from=not-a-date`);
    expect(r.status()).toBe(400);
    expect((await r.json()).code).toBe("INVALID_DATE_RANGE");
  });

  test("garbage ?to → 400 INVALID_DATE_RANGE (ca.csv)", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token) {
      test.skip(true, "travel admin login unavailable");
      return;
    }
    const r = await get(request, token, `${CSV_PATH}?to=not-a-date`);
    expect(r.status()).toBe(400);
    expect((await r.json()).code).toBe("INVALID_DATE_RANGE");
  });

  test("unknown ?subBrand → 400 INVALID_SUB_BRAND", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token) {
      test.skip(true, "travel admin login unavailable");
      return;
    }
    const r = await get(request, token, `${CSV_PATH}?subBrand=bogus`);
    expect(r.status()).toBe(400);
    expect((await r.json()).code).toBe("INVALID_SUB_BRAND");
  });
});

// ─── Happy paths ────────────────────────────────────────────────────

test.describe("Travel invoice exports — happy paths", () => {
  test("tally.xml → 200 application/xml attachment with Tally envelope", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token) {
      test.skip(true, "travel admin login unavailable");
      return;
    }
    const r = await get(request, token, TALLY_PATH);
    expect(r.status()).toBe(200);
    expect(r.headers()["content-type"]).toContain("application/xml");
    const disposition = r.headers()["content-disposition"] || "";
    expect(disposition).toContain("attachment");
    expect(disposition).toContain(".xml");

    const body = await r.text();
    expect(body.startsWith("<?xml")).toBe(true);
    expect(body).toContain("<ENVELOPE>");
    expect(body).toContain("<TALLYREQUEST>Import Data</TALLYREQUEST>");
    expect(body).toContain("<REPORTNAME>Vouchers</REPORTNAME>");
    expect(body).toContain("</ENVELOPE>");
    // Voucher count is seed-dependent — only sniff that IF vouchers are
    // present they're well-formed Sales creates.
    if (body.includes("<TALLYMESSAGE>")) {
      expect(body).toContain('<VOUCHER VCHTYPE="Sales" ACTION="Create">');
      expect(body).toContain("<PARTYLEDGERNAME>");
    }
  });

  test("ca.csv → 200 text/csv attachment with pinned header row", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token) {
      test.skip(true, "travel admin login unavailable");
      return;
    }
    const r = await get(request, token, CSV_PATH);
    expect(r.status()).toBe(200);
    expect(r.headers()["content-type"]).toContain("text/csv");
    const disposition = r.headers()["content-disposition"] || "";
    expect(disposition).toContain("attachment");
    expect(disposition).toContain(".csv");

    const body = await r.text();
    // Strip the Excel-friendly BOM before the header sniff.
    const firstLine = body.replace(/^\uFEFF/, "").split("\r\n")[0];
    expect(firstLine).toBe(
      "Invoice Number,Invoice Date,Customer,Customer GSTIN,Sub-Brand,Legal Entity,Line Description,HSN/SAC,Taxable Value,CGST,SGST,IGST,TCS,Invoice Total,Status",
    );
  });

  test("explicit FY window + subBrand filter → 200 on both endpoints", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token) {
      test.skip(true, "travel admin login unavailable");
      return;
    }
    const qs = "?from=2025-04-01&to=2026-03-31&subBrand=tmc";
    const xml = await get(request, token, `${TALLY_PATH}${qs}`);
    expect(xml.status()).toBe(200);
    expect((await xml.text())).toContain("<ENVELOPE>");

    const csv = await get(request, token, `${CSV_PATH}${qs}`);
    expect(csv.status()).toBe(200);
    expect((await csv.text())).toContain("Invoice Number,Invoice Date");
  });
});
