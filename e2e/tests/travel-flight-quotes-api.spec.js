// @ts-check
/**
 * Gate spec — Flight quick-quote agent endpoint (PRD §7 / gap A1).
 *
 *   POST /api/v1/flight-plugin/agent-quotes   — JWT auth (verifyToken +
 *                                               requireTravelTenant)
 *
 * The authed in-CRM mirror of the Chrome-plugin receiver in the same route
 * file (routes/travel_flight_quotes.js). FlightQuoteAgent.jsx
 * (/travel/flights/quote) drives it: up to 4 manually-entered flight options,
 * markup applied server-side via lib/travelPricing.pickMarkup (FR-6 single
 * source of truth), each option persisted as a flight ItineraryItem on a
 * draft Itinerary (created on the fly when no itineraryId is supplied —
 * gated by the PRD §4.1 diagnostic-first guard, exactly like
 * POST /api/travel/itineraries).
 *
 * The X-API-Key plugin endpoint's auth gate stays pinned in the sibling
 * tests/travel-flight-plugin-api.spec.js — this spec covers only the NEW
 * JWT variant:
 *   - auth gate (no token → 401/403; generic-vertical admin → 403 WRONG_VERTICAL)
 *   - validation (MISSING_CONTACT / MISSING_OPTIONS / TOO_MANY_OPTIONS /
 *     MISSING_AIRLINE / INVALID_PRICE / MISSING_ROUTE / MISSING_SUB_BRAND /
 *     INVALID_SUB_BRAND / CONTACT_NOT_FOUND / MARKUP_RULE_NOT_FOUND)
 *   - PRD §4.1 diagnostic-first guard (403 DIAGNOSTIC_REQUIRED)
 *   - happy path: 201 envelope { itineraryId, items[], totalWithMarkup,
 *     currency, pdfUrl } + items visible on GET /itineraries/:id
 *   - attach-to-existing-itinerary path (itineraryId supplied, no subBrand)
 *   - pinned markup rule (markupRuleId → flat amount lands on every option)
 *
 * Standing rules honoured: travel-vertical caller is yasin@travelstall.in
 * (ADMIN on the travel tenant); generic admin@globussoft.com drives the
 * WRONG_VERTICAL probe. Test rows tagged with RUN_TAG; afterAll deletes the
 * created itineraries (items cascade), markup rule and contacts.
 */

const { test, expect } = require("@playwright/test");

test.describe.configure({ mode: "serial" });

const BASE_URL = process.env.BASE_URL || "https://crm.globusdemos.com";
const REQUEST_TIMEOUT = 60000;
const RUN_TAG = `E2E_FLTQ_${Date.now()}`;
const AGENT_QUOTES = "/api/v1/flight-plugin/agent-quotes";

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
async function del(request, token, path) {
  return retryOn5xx(() => request.delete(`${BASE_URL}${path}`, { headers: headers(token), timeout: REQUEST_TIMEOUT }));
}

// Minimal valid option factory.
function flightOption(overrides = {}) {
  return {
    airline: "AI",
    flightNumber: "AI-302",
    fareClass: "Economy",
    pricePerPax: 10000,
    route: { from: "DEL", to: "JED" },
    departAt: "2026-08-01T08:30:00.000Z",
    arriveAt: "2026-08-01T12:10:00.000Z",
    baggage: "25kg + 7kg cabin",
    ...overrides,
  };
}

// ── Fixtures + cleanup tracking ─────────────────────────────────────
let contactId = null; // has an RFU diagnostic — happy-path contact
let noDiagContactId = null; // NO diagnostic — drives DIAGNOSTIC_REQUIRED
const created = { itineraryIds: [], ruleIds: [] };

test.beforeAll(async ({ request }) => {
  const token = await getTravelAdmin(request);
  if (!token) return;

  // Contact A — with an RFU diagnostic (PRD §4.1 guard satisfied).
  const c1 = await post(request, token, "/api/contacts", {
    name: `${RUN_TAG} Flight Quote Contact`,
    email: `${RUN_TAG.toLowerCase()}@e2e.test`,
    phone: `+91${String(Date.now()).slice(-10)}`,
    subBrand: "rfu",
  });
  if (c1.ok()) {
    const body = await c1.json();
    contactId = body.id || body.contact?.id;
  }
  if (contactId) {
    const banksRes = await get(request, token, "/api/travel/diagnostic-banks?subBrand=rfu&active=true");
    if (banksRes.ok()) {
      const banks = (await banksRes.json()).banks || [];
      const rfuBank = banks.find((b) => b.subBrand === "rfu");
      if (rfuBank) {
        await post(request, token, "/api/travel/diagnostics", {
          bankId: rfuBank.id,
          answers: { q1: "few", q2: "medium" },
          contactId,
        }).catch(() => null);
      }
    }
  }

  // Contact B — intentionally NO diagnostic.
  const c2 = await post(request, token, "/api/contacts", {
    name: `${RUN_TAG} No Diagnostic Contact`,
    email: `${RUN_TAG.toLowerCase()}.nodiag@e2e.test`,
    phone: `+91${String(Date.now() + 7).slice(-10)}`,
    subBrand: "rfu",
  });
  if (c2.ok()) {
    const body = await c2.json();
    noDiagContactId = body.id || body.contact?.id;
  }
});

test.afterAll(async ({ request }) => {
  const token = await getTravelAdmin(request);
  if (!token) return;
  const deadline = Date.now() + 40_000;
  // Itineraries cascade-delete their items.
  for (const id of created.itineraryIds) {
    if (Date.now() > deadline) break;
    await del(request, token, `/api/travel/itineraries/${id}`).catch(() => {});
  }
  for (const id of created.ruleIds) {
    if (Date.now() > deadline) break;
    await del(request, token, `/api/travel/markup-rules/${id}`).catch(() => {});
  }
  for (const cid of [contactId, noDiagContactId]) {
    if (cid) await del(request, token, `/api/contacts/${cid}`).catch(() => {});
  }
});

// ── Auth gate ───────────────────────────────────────────────────────

test.describe("Flight agent-quotes API — auth gate", () => {
  test("POST without token → 401/403", async ({ request }) => {
    const res = await request.post(`${BASE_URL}${AGENT_QUOTES}`, {
      data: { contactId: 1, options: [flightOption()] },
      headers: { "Content-Type": "application/json" },
      timeout: REQUEST_TIMEOUT,
    });
    expect([401, 403]).toContain(res.status());
  });

  test("generic-vertical admin → 403 WRONG_VERTICAL", async ({ request }) => {
    const token = await getGenericAdmin(request);
    if (!token) test.skip(true, "admin@globussoft.com not seeded");
    const res = await post(request, token, AGENT_QUOTES, {
      contactId: 1,
      subBrand: "rfu",
      options: [flightOption()],
    });
    expect(res.status()).toBe(403);
    expect((await res.json()).code).toBe("WRONG_VERTICAL");
  });
});

// ── Validation ──────────────────────────────────────────────────────

test.describe("Flight agent-quotes API — validation", () => {
  test("missing contactId → 400 MISSING_CONTACT", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token) test.skip(true, "travel admin not seeded");
    const res = await post(request, token, AGENT_QUOTES, {
      subBrand: "rfu",
      options: [flightOption()],
    });
    expect(res.status()).toBe(400);
    expect((await res.json()).code).toBe("MISSING_CONTACT");
  });

  test("empty options → 400 MISSING_OPTIONS", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token || !contactId) test.skip(true, "fixture contact missing");
    const res = await post(request, token, AGENT_QUOTES, {
      contactId,
      subBrand: "rfu",
      options: [],
    });
    expect(res.status()).toBe(400);
    expect((await res.json()).code).toBe("MISSING_OPTIONS");
  });

  test("5 options → 400 TOO_MANY_OPTIONS (PRD §7 cap is 4)", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token || !contactId) test.skip(true, "fixture contact missing");
    const res = await post(request, token, AGENT_QUOTES, {
      contactId,
      subBrand: "rfu",
      options: [flightOption(), flightOption(), flightOption(), flightOption(), flightOption()],
    });
    expect(res.status()).toBe(400);
    expect((await res.json()).code).toBe("TOO_MANY_OPTIONS");
  });

  test("option without airline → 400 MISSING_AIRLINE", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token || !contactId) test.skip(true, "fixture contact missing");
    const res = await post(request, token, AGENT_QUOTES, {
      contactId,
      subBrand: "rfu",
      options: [flightOption({ airline: "" })],
    });
    expect(res.status()).toBe(400);
    expect((await res.json()).code).toBe("MISSING_AIRLINE");
  });

  test("negative pricePerPax → 400 INVALID_PRICE", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token || !contactId) test.skip(true, "fixture contact missing");
    const res = await post(request, token, AGENT_QUOTES, {
      contactId,
      subBrand: "rfu",
      options: [flightOption({ pricePerPax: -5 })],
    });
    expect(res.status()).toBe(400);
    expect((await res.json()).code).toBe("INVALID_PRICE");
  });

  test("option without route → 400 MISSING_ROUTE", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token || !contactId) test.skip(true, "fixture contact missing");
    const res = await post(request, token, AGENT_QUOTES, {
      contactId,
      subBrand: "rfu",
      options: [flightOption({ route: { from: "DEL", to: "" } })],
    });
    expect(res.status()).toBe(400);
    expect((await res.json()).code).toBe("MISSING_ROUTE");
  });

  test("unknown contact → 404 CONTACT_NOT_FOUND", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token) test.skip(true, "travel admin not seeded");
    const res = await post(request, token, AGENT_QUOTES, {
      contactId: 99999999,
      subBrand: "rfu",
      options: [flightOption()],
    });
    expect(res.status()).toBe(404);
    expect((await res.json()).code).toBe("CONTACT_NOT_FOUND");
  });

  test("no subBrand and no itineraryId → 400 MISSING_SUB_BRAND", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token || !contactId) test.skip(true, "fixture contact missing");
    const res = await post(request, token, AGENT_QUOTES, {
      contactId,
      options: [flightOption()],
    });
    expect(res.status()).toBe(400);
    expect((await res.json()).code).toBe("MISSING_SUB_BRAND");
  });

  test("garbage subBrand → 400 INVALID_SUB_BRAND", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token || !contactId) test.skip(true, "fixture contact missing");
    const res = await post(request, token, AGENT_QUOTES, {
      contactId,
      subBrand: "umrah",
      options: [flightOption()],
    });
    expect(res.status()).toBe(400);
    expect((await res.json()).code).toBe("INVALID_SUB_BRAND");
  });

  test("unknown markupRuleId → 404 MARKUP_RULE_NOT_FOUND", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token || !contactId) test.skip(true, "fixture contact missing");
    const res = await post(request, token, AGENT_QUOTES, {
      contactId,
      subBrand: "rfu",
      markupRuleId: 99999999,
      options: [flightOption()],
    });
    expect(res.status()).toBe(404);
    expect((await res.json()).code).toBe("MARKUP_RULE_NOT_FOUND");
  });
});

// ── PRD §4.1 diagnostic-first guard ─────────────────────────────────

test.describe("Flight agent-quotes API — diagnostic-first guard", () => {
  test("contact without a diagnostic → 403 DIAGNOSTIC_REQUIRED", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token || !noDiagContactId) test.skip(true, "no-diagnostic fixture contact missing");
    const res = await post(request, token, AGENT_QUOTES, {
      contactId: noDiagContactId,
      subBrand: "rfu",
      options: [flightOption()],
    });
    expect(res.status()).toBe(403);
    expect((await res.json()).code).toBe("DIAGNOSTIC_REQUIRED");
  });
});

// ── Happy paths ─────────────────────────────────────────────────────

test.describe("Flight agent-quotes API — happy paths", () => {
  test("201 creates a draft itinerary with one flight item per option", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token || !contactId) test.skip(true, "fixture contact missing — beforeAll diagnostic submission likely failed");
    const res = await post(request, token, AGENT_QUOTES, {
      contactId,
      subBrand: "rfu",
      currency: "inr", // route upper-cases
      options: [
        flightOption({ airline: "AI", pricePerPax: 10000 }),
        flightOption({ airline: "SV", flightNumber: "SV-759", pricePerPax: 12000, fareClass: "Business" }),
      ],
    });
    expect(res.status(), `agent-quotes create: ${await res.text()}`).toBe(201);
    const body = await res.json();

    // Envelope shape — mirrors the plugin's per-item envelope, plus the
    // itinerary id + branded-PDF URL the agent page consumes.
    expect(typeof body.itineraryId).toBe("number");
    created.itineraryIds.push(body.itineraryId);
    expect(Array.isArray(body.items)).toBe(true);
    expect(body.items.length).toBe(2);
    for (const it of body.items) {
      expect(typeof it.itineraryItemId).toBe("number");
      expect(typeof it.totalWithMarkup).toBe("number");
      expect(it.currency).toBe("INR");
    }
    expect(body.currency).toBe("INR");
    expect(body.pdfUrl).toBe(`/api/travel/itineraries/${body.itineraryId}/pdf`);
    // Markup is non-negative → totals at least the raw fares; grand total
    // equals the per-item sum (2dp rounded server-side).
    expect(body.items[0].totalWithMarkup).toBeGreaterThanOrEqual(10000);
    expect(body.items[1].totalWithMarkup).toBeGreaterThanOrEqual(12000);
    const sum = Math.round((body.items[0].totalWithMarkup + body.items[1].totalWithMarkup) * 100) / 100;
    expect(body.totalWithMarkup).toBe(sum);

    // Items are visible through the standard itinerary read path.
    const itinRes = await get(request, token, `/api/travel/itineraries/${body.itineraryId}`);
    expect(itinRes.status()).toBe(200);
    const itin = await itinRes.json();
    expect(itin.status).toBe("draft");
    expect(itin.subBrand).toBe("rfu");
    const items = itin.items || [];
    expect(items.length).toBe(2);
    expect(items.every((i) => i.itemType === "flight")).toBe(true);
    expect(items[0].description).toContain("DEL→JED");

    // Branded PDF renders for the same itinerary (bearer-token fetch — the
    // browser path uses the ?_t= promotion, but the header path is equivalent).
    const pdfRes = await get(request, token, body.pdfUrl);
    expect(pdfRes.status()).toBe(200);
    expect(pdfRes.headers()["content-type"] || "").toContain("application/pdf");
  });

  test("201 attaches to an existing itinerary when itineraryId is supplied (no subBrand needed)", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token || !contactId) test.skip(true, "fixture contact missing");
    // Seed an itinerary through the standard route (diagnostic already taken).
    const seed = await post(request, token, "/api/travel/itineraries", {
      subBrand: "rfu",
      contactId,
      destination: `${RUN_TAG} attach-target`,
    });
    expect(seed.status(), `itinerary seed: ${await seed.text()}`).toBe(201);
    const itinId = (await seed.json()).id;
    created.itineraryIds.push(itinId);

    const res = await post(request, token, AGENT_QUOTES, {
      contactId,
      itineraryId: itinId,
      options: [flightOption({ pricePerPax: 8000 })],
    });
    expect(res.status(), `attach create: ${await res.text()}`).toBe(201);
    const body = await res.json();
    expect(body.itineraryId).toBe(itinId);
    expect(body.items.length).toBe(1);

    const itinRes = await get(request, token, `/api/travel/itineraries/${itinId}`);
    expect(itinRes.status()).toBe(200);
    expect(((await itinRes.json()).items || []).length).toBe(1);
  });

  test("201 with pinned markupRuleId applies that rule's flat amount to every option", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token || !contactId) test.skip(true, "fixture contact missing");
    // Mint a dedicated flat rule so the expected total is deterministic
    // regardless of whatever auto-pick rules exist on the demo tenant.
    const ruleRes = await post(request, token, "/api/travel/markup-rules", {
      subBrand: "rfu",
      scope: "flight",
      matchKeyJson: JSON.stringify({ tag: RUN_TAG }),
      markupFlat: 500,
      priority: 1,
    });
    expect(ruleRes.status(), `rule seed: ${await ruleRes.text()}`).toBe(201);
    const ruleId = (await ruleRes.json()).id;
    created.ruleIds.push(ruleId);

    const res = await post(request, token, AGENT_QUOTES, {
      contactId,
      subBrand: "rfu",
      markupRuleId: ruleId,
      options: [
        flightOption({ pricePerPax: 10000 }),
        flightOption({ pricePerPax: 6500.5 }),
      ],
    });
    expect(res.status(), `pinned-rule create: ${await res.text()}`).toBe(201);
    const body = await res.json();
    created.itineraryIds.push(body.itineraryId);
    expect(body.items[0].totalWithMarkup).toBe(10500);
    expect(body.items[1].totalWithMarkup).toBe(7000.5);
    expect(body.totalWithMarkup).toBe(17500.5);
  });
});
