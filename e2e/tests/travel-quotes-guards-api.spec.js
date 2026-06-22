// @ts-check
/**
 * Gate spec — Travel quote-creation guards (gaps A9a + A6,
 * docs/TRAVEL_PRD_GAP_ANALYSIS_2026-06-12.md).
 *
 * Route: backend/routes/travel_quotes.js.
 *
 * 1. PRD §4.1 diagnostic-first guard on POST /api/travel/quotes:
 *    HISTORICAL — the quote surface no longer enforces a completed
 *    TravelDiagnostic before quote creation (nexus-DMC flow, 2026-06-22).
 *    The itinerary surface still enforces the guard. The spec below pins
 *    the new permissive contract so the change does not regress.
 *
 * 2. PRD §4.4 Visa Sure complexity gate:
 *    - body.quoteMode is request-level only ("manual"|"structured",
 *      default "manual"; garbage → 400 INVALID_QUOTE_MODE). TravelQuote
 *      has no quoteMode column, so the mode is NOT persisted.
 *    - subBrand "visasure" + contact with any complexCase=true
 *      VisaApplication → structured creation rejects 422
 *      VISA_COMPLEX_CASE_MANUAL_ONLY; default/manual creation succeeds
 *      201 and echoes { complexCase: true, quoteMode: "manual" }.
 *    - GET /quotes/:id/pricing-preview (the structured markup-rule
 *      auto-pricing surface) rejects 422 VISA_COMPLEX_CASE_MANUAL_ONLY
 *      for such quotes.
 *    - Non-visasure 201 responses keep the pre-gap shape (no
 *      complexCase/quoteMode keys) — additive-only contract.
 *
 * Conventions: cloned from notifications-api.spec.js /
 * travel-itineraries-api.spec.js (loginAs + retryOn5xx + serial mode).
 * Test data tagged with RUN_TAG (E2E_FLOW_ prefix per
 * e2e/test-data-patterns.js); afterAll deletes created quotes + contacts
 * by id. Diagnostics + visa-application rows have no DELETE endpoint —
 * they stay behind tagged (destinationCountry carries the RUN_TAG),
 * matching the travel-visa-applications-api.spec.js precedent. The
 * visasure diagnostic bank is created ONLY if the stack has no active one
 * (config row, reused by later runs — seed-travel.js seeds tmc + rfu
 * banks but no visasure bank as of 2026-06-12).
 */

const { test, expect } = require("@playwright/test");

// Shared beforeAll-created fixtures + ordered guard→happy flow: pin to one
// worker, sequential (same rationale as notifications-api.spec.js).
test.describe.configure({ mode: "serial" });

const BASE_URL = process.env.BASE_URL || "https://crm.globusdemos.com";
const REQUEST_TIMEOUT = 60000;
const RUN_TAG = `E2E_FLOW_TQG_${Date.now()}`;

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
    request.get(`${BASE_URL}${path}`, { headers: headers(token), timeout: REQUEST_TIMEOUT }),
  );
}
async function post(request, token, path, body) {
  return retryOn5xx(() =>
    request.post(`${BASE_URL}${path}`, { headers: headers(token), data: body ?? {}, timeout: REQUEST_TIMEOUT }),
  );
}
async function patch(request, token, path, body) {
  return retryOn5xx(() =>
    request.patch(`${BASE_URL}${path}`, { headers: headers(token), data: body ?? {}, timeout: REQUEST_TIMEOUT }),
  );
}
async function del(request, token, path) {
  return retryOn5xx(() =>
    request.delete(`${BASE_URL}${path}`, { headers: headers(token), timeout: REQUEST_TIMEOUT }),
  );
}

// ── Fixtures ────────────────────────────────────────────────────────
// contactNoDiag      tmc contact, NO diagnostic        → 422 path
// contactWithDiag    tmc contact + tmc diagnostic      → 201 path
// visaComplexContact visasure + diagnostic + complexCase=true VisaApplication
// visaSimpleContact  visasure + diagnostic, no VisaApplication
let contactNoDiagId = null;
let contactWithDiagId = null;
let visaComplexContactId = null;
let visaSimpleContactId = null;
let complexVisaQuoteId = null; // 201 quote for the complex contact (manual mode)
const createdQuoteIds = [];
const createdContactIds = [];

async function createContact(request, token, label, subBrand, phoneSuffix) {
  const r = await post(request, token, "/api/contacts", {
    name: `${RUN_TAG} ${label}`,
    email: `${RUN_TAG.toLowerCase()}.${phoneSuffix}@e2e.test`,
    phone: `+91${String(Date.now()).slice(-8)}${(process.pid % 10)}${phoneSuffix}`,
    subBrand,
  });
  if (!r.ok()) return null;
  const body = await r.json();
  const id = body.id || body.contact?.id;
  if (id) createdContactIds.push(id);
  return id || null;
}

// Submit a diagnostic for (contactId, subBrand) against an active bank.
// For visasure, seed-travel.js ships no bank — create a minimal one once.
async function submitDiagnostic(request, token, contactId, subBrand) {
  let bankId = null;
  const banksRes = await get(
    request, token,
    `/api/travel/diagnostic-banks?subBrand=${subBrand}&active=true`,
  );
  if (banksRes.ok()) {
    const banks = (await banksRes.json()).banks || [];
    const match = banks.find((b) => b.subBrand === subBrand && b.isActive !== false);
    if (match) bankId = match.id;
  }
  if (!bankId) {
    const bankRes = await post(request, token, "/api/travel/diagnostic-banks", {
      subBrand,
      questionsJson: JSON.stringify({
        questions: [
          { id: "q1", label: "Have you travelled abroad before?", type: "select", options: ["yes", "no"] },
        ],
      }),
      scoringRulesJson: JSON.stringify({
        method: "sum",
        bands: [{ min: 0, max: 100, classification: "level_1", label: "Basic" }],
      }),
    });
    if (bankRes.ok()) bankId = (await bankRes.json()).id;
  }
  if (!bankId) return false;
  const diagRes = await post(request, token, "/api/travel/diagnostics", {
    bankId,
    answers: { q1: "yes" },
    contactId,
  });
  return diagRes.ok();
}

test.beforeAll(async ({ request }) => {
  const token = await getTravelAdmin(request);
  if (!token) return;

  contactNoDiagId = await createContact(request, token, "NoDiag Contact", "tmc", "1");

  contactWithDiagId = await createContact(request, token, "Diag Contact", "tmc", "2");
  if (contactWithDiagId) {
    const ok = await submitDiagnostic(request, token, contactWithDiagId, "tmc");
    if (!ok) contactWithDiagId = null; // force skip rather than false-fail
  }

  visaComplexContactId = await createContact(request, token, "Visa Complex", "visasure", "3");
  if (visaComplexContactId) {
    const ok = await submitDiagnostic(request, token, visaComplexContactId, "visasure");
    if (ok) {
      // Visa application + complexCase flip (PATCH — complexCase isn't a
      // create-body field).
      const appRes = await post(request, token, "/api/travel/visa/applications", {
        contactId: visaComplexContactId,
        applicationType: "tourist",
        destinationCountry: `${RUN_TAG} Testland`,
      });
      if (appRes.ok()) {
        const app = await appRes.json();
        const appId = app.id || app.application?.id;
        const flipRes = appId
          ? await patch(request, token, `/api/travel/visa/applications/${appId}`, { complexCase: true })
          : null;
        if (!flipRes || !flipRes.ok()) visaComplexContactId = null;
      } else {
        visaComplexContactId = null;
      }
    } else {
      visaComplexContactId = null;
    }
  }

  visaSimpleContactId = await createContact(request, token, "Visa Simple", "visasure", "4");
  if (visaSimpleContactId) {
    const ok = await submitDiagnostic(request, token, visaSimpleContactId, "visasure");
    if (!ok) visaSimpleContactId = null;
  }
});

test.afterAll(async ({ request }) => {
  const token = await getTravelAdmin(request);
  if (!token) return;
  const deadline = Date.now() + 40_000;
  for (const id of createdQuoteIds) {
    if (Date.now() > deadline) break;
    await del(request, token, `/api/travel/quotes/${id}`).catch(() => {});
  }
  for (const id of createdContactIds) {
    if (Date.now() > deadline) break;
    await del(request, token, `/api/contacts/${id}`).catch(() => {});
  }
  // TravelDiagnostic + VisaApplication rows have no DELETE endpoint —
  // they remain tagged with the RUN_TAG (precedent:
  // travel-visa-applications-api.spec.js).
});

// ─── Auth + vertical guards ─────────────────────────────────────────

test.describe("Travel quotes guards — auth + vertical", () => {
  test("POST /quotes without token → 401/403", async ({ request }) => {
    const r = await request.post(`${BASE_URL}/api/travel/quotes`, {
      data: { contactId: 1, totalAmount: 100, currency: "INR" },
      headers: { "Content-Type": "application/json" },
      timeout: REQUEST_TIMEOUT,
    });
    expect([401, 403]).toContain(r.status());
  });

  test("POST /quotes from generic-vertical ADMIN → 403 WRONG_VERTICAL", async ({ request }) => {
    const token = await getGenericAdmin(request);
    if (!token) test.skip(true, "admin@globussoft.com not seeded");
    const r = await post(request, token, "/api/travel/quotes", {
      contactId: 1, totalAmount: 100, currency: "INR",
    });
    expect(r.status()).toBe(403);
    expect((await r.json()).code).toBe("WRONG_VERTICAL");
  });
});

// ─── PRD §4.1 diagnostic-first guard (historical / disabled for quotes) ─

test.describe("Travel quotes guards — diagnostic no longer required", () => {
  test("contact without a diagnostic → 201 (guard removed for quote creation)", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token || !contactNoDiagId) test.skip(true, "travel admin / fixture contact unavailable");
    const r = await post(request, token, "/api/travel/quotes", {
      contactId: contactNoDiagId,
      totalAmount: 1000,
      currency: "INR",
      subBrand: "tmc",
    });
    expect(r.status(), `expected 201, got ${r.status()}: ${await r.text()}`).toBe(201);
    const body = await r.json();
    expect(body.id).toBeTruthy();
    createdQuoteIds.push(body.id);
  });

  test("diagnostic exists for tmc but quote targets rfu → 201 (per-subBrand match not enforced)", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token || !contactWithDiagId) test.skip(true, "travel admin / fixture contact unavailable");
    const r = await post(request, token, "/api/travel/quotes", {
      contactId: contactWithDiagId,
      totalAmount: 1000,
      currency: "INR",
      subBrand: "rfu", // diagnostic was submitted for tmc, but quotes no longer enforce the match
    });
    expect(r.status(), `expected 201, got ${r.status()}: ${await r.text()}`).toBe(201);
    const body = await r.json();
    expect(body.id).toBeTruthy();
    createdQuoteIds.push(body.id);
  });

  test("contact WITH a matching diagnostic → 201 (non-visasure shape unchanged)", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token || !contactWithDiagId) test.skip(true, "travel admin / fixture contact unavailable");
    const r = await post(request, token, "/api/travel/quotes", {
      contactId: contactWithDiagId,
      totalAmount: 1500,
      currency: "INR",
      subBrand: "tmc",
    });
    expect(r.status(), `expected 201, got ${r.status()}: ${await r.text()}`).toBe(201);
    const body = await r.json();
    expect(body.id).toBeTruthy();
    createdQuoteIds.push(body.id);
    // Additive-only contract: the visa-gate echo fields must NOT leak
    // into non-visasure responses.
    expect(body).not.toHaveProperty("complexCase");
    expect(body).not.toHaveProperty("quoteMode");
  });
});

// ─── PRD §4.4 Visa Sure complexity gate (gap A6) ────────────────────

test.describe("Travel quotes guards — Visa Sure complexity gate (PRD §4.4)", () => {
  test("garbage quoteMode → 400 INVALID_QUOTE_MODE", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token || !contactWithDiagId) test.skip(true, "travel admin / fixture contact unavailable");
    const r = await post(request, token, "/api/travel/quotes", {
      contactId: contactWithDiagId,
      totalAmount: 1000,
      currency: "INR",
      subBrand: "tmc",
      quoteMode: "auto-magic",
    });
    expect(r.status()).toBe(400);
    expect((await r.json()).code).toBe("INVALID_QUOTE_MODE");
  });

  test("complex visa case + quoteMode=structured → 422 VISA_COMPLEX_CASE_MANUAL_ONLY", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token || !visaComplexContactId) {
      test.skip(true, "complex-visa fixture unavailable (bank/application setup failed)");
    }
    const r = await post(request, token, "/api/travel/quotes", {
      contactId: visaComplexContactId,
      totalAmount: 5000,
      currency: "INR",
      subBrand: "visasure",
      quoteMode: "structured",
    });
    expect(r.status(), `expected 422, got ${r.status()}: ${await r.text()}`).toBe(422);
    expect((await r.json()).code).toBe("VISA_COMPLEX_CASE_MANUAL_ONLY");
  });

  test("complex visa case + default mode → 201 echoing complexCase:true + quoteMode:manual", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token || !visaComplexContactId) {
      test.skip(true, "complex-visa fixture unavailable (bank/application setup failed)");
    }
    const r = await post(request, token, "/api/travel/quotes", {
      contactId: visaComplexContactId,
      totalAmount: 5000,
      currency: "INR",
      subBrand: "visasure",
    });
    expect(r.status(), `expected 201, got ${r.status()}: ${await r.text()}`).toBe(201);
    const body = await r.json();
    expect(body.id).toBeTruthy();
    createdQuoteIds.push(body.id);
    complexVisaQuoteId = body.id;
    expect(body.complexCase).toBe(true);
    expect(body.quoteMode).toBe("manual");
  });

  test("pricing-preview (structured auto-pricing) on a complex-case quote → 422", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token || !complexVisaQuoteId) {
      test.skip(true, "complex-visa quote unavailable (creation test skipped/failed)");
    }
    const r = await get(request, token, `/api/travel/quotes/${complexVisaQuoteId}/pricing-preview`);
    expect(r.status(), `expected 422, got ${r.status()}: ${await r.text()}`).toBe(422);
    expect((await r.json()).code).toBe("VISA_COMPLEX_CASE_MANUAL_ONLY");
  });

  test("NON-complex visasure contact may create a structured quote → 201 with complexCase:false", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token || !visaSimpleContactId) {
      test.skip(true, "simple-visa fixture unavailable (bank setup failed)");
    }
    const r = await post(request, token, "/api/travel/quotes", {
      contactId: visaSimpleContactId,
      totalAmount: 3000,
      currency: "INR",
      subBrand: "visasure",
      quoteMode: "structured",
    });
    expect(r.status(), `expected 201, got ${r.status()}: ${await r.text()}`).toBe(201);
    const body = await r.json();
    expect(body.id).toBeTruthy();
    createdQuoteIds.push(body.id);
    expect(body.complexCase).toBe(false);
    expect(body.quoteMode).toBe("structured");
  });
});
