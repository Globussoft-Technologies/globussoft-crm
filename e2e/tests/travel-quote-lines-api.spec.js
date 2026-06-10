// @ts-check
/**
 * Arc 2 #900 slice 7 — gate spec for TravelQuoteLine endpoints.
 *
 * Pins the four line-item endpoints added to backend/routes/travel_quotes.js
 * (commit f7203b8e), the parent-quote totalAmount recompute side-effect,
 * and the duplicate-quote line cloning. Companion to the mocked-prisma
 * vitest at backend/test/routes/travel-quote-lines.test.js — this spec
 * exercises the same contracts against the deployed backend with a real
 * TravelQuote + Contact + sub-brand-scoped tenant.
 *
 * Endpoints covered:
 *   GET    /api/travel/quotes/:id/lines              any verified token
 *   POST   /api/travel/quotes/:id/lines              ADMIN/MANAGER
 *   PUT    /api/travel/quotes/:id/lines/:lineId      ADMIN/MANAGER
 *   DELETE /api/travel/quotes/:id/lines/:lineId      ADMIN/MANAGER
 *   POST   /api/travel/quotes/:id/duplicate          ADMIN/MANAGER  (line-clone branch)
 *
 * Contracts asserted end-to-end:
 *   - amount is computed server-side as quantity * unitPrice (NOT trusted
 *     from the body); PUT recomputes amount when either qty or unitPrice
 *     changes independently.
 *   - currency falls back to the parent quote's currency when the body
 *     omits it.
 *   - Parent quote's totalAmount is recomputed after POST (and stays
 *     consistent with the sum of surviving lines via re-fetch).
 *   - Validation:
 *       description empty/missing → 400 MISSING_FIELDS
 *       lineType not in VALID_LINE_TYPES → 400 INVALID_LINE_TYPE
 *       unitPrice negative → 400 INVALID_AMOUNT
 *   - Cross-tenant: a quote not owned by the travel tenant yields 404
 *     QUOTE_NOT_FOUND on /lines (the generic admin's tenant CAN reach
 *     /api/travel only via WRONG_VERTICAL — covered by other specs; here
 *     we pin the loadParentQuote 404 path with a bogus id).
 *   - Duplicate quote clones lines: POST /quotes/:id/duplicate then
 *     GET /quotes/:newId/lines returns the same set (count + descriptions).
 *
 * Auth deps: yasin@travelstall.in (travel ADMIN, seed-travel.js).
 *
 * Cleanup: parent quote is hard-deleted in afterAll; lines cascade with
 * the parent. Contact created in beforeAll is also deleted.
 */

const { test, expect } = require("@playwright/test");

test.describe.configure({ mode: "serial" });

const BASE_URL = process.env.BASE_URL || "https://crm.globusdemos.com";
const REQUEST_TIMEOUT = 60000;
const RUN_TAG = `E2E_TRAVEL_QL_${Date.now()}_${process.pid}`;

let travelAdminToken = null;
let genericAdminToken = null;
let testContactId = null;
let parentQuoteId = null;
let duplicateQuoteId = null;

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
async function put(request, token, path, body) {
  return retryOn5xx(() =>
    request.put(`${BASE_URL}${path}`, { headers: headers(token), data: body ?? {}, timeout: REQUEST_TIMEOUT }),
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

  // Create a Contact owned by the travel tenant — tagged with RUN_TAG so
  // demo-scrub + teardown-completeness can sweep it cleanly. Phone is
  // bucketed off Date.now()+pid to avoid the "phone unique-index" collision
  // class that bit cross-shard parallel runs on travel-itineraries-api.
  const contactRes = await post(request, token, "/api/contacts", {
    name: `${RUN_TAG} QuoteLine Test Contact`,
    email: `${RUN_TAG.toLowerCase()}@e2e.test`,
    phone: `+91${String(Date.now()).slice(-9)}${(process.pid % 10)}`,
    subBrand: "tmc",
  });
  if (contactRes.ok()) {
    const body = await contactRes.json();
    testContactId = body.id || body.contact?.id;
  }
  if (!testContactId) return;

  // Create the parent TravelQuote that all line-item tests will attach to.
  // Status Draft + a far-future validUntil so the row stays valid across
  // the spec's wall-clock + any retry budget.
  const quoteRes = await post(request, token, "/api/travel/quotes", {
    contactId: testContactId,
    totalAmount: 0,
    currency: "INR",
    subBrand: "tmc",
    status: "Draft",
    validUntil: new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10),
  });
  if (quoteRes.ok()) {
    const body = await quoteRes.json();
    parentQuoteId = body.id;
  }
});

test.afterAll(async ({ request }) => {
  const token = await getTravelAdmin(request);
  if (!token) return;
  // Lines cascade-delete with the parent quote (FK ON DELETE CASCADE).
  if (duplicateQuoteId) {
    await del(request, token, `/api/travel/quotes/${duplicateQuoteId}`).catch(() => {});
  }
  if (parentQuoteId) {
    await del(request, token, `/api/travel/quotes/${parentQuoteId}`).catch(() => {});
  }
  if (testContactId) {
    await del(request, token, `/api/contacts/${testContactId}`).catch(() => {});
  }
});

// ─── Vertical + parent guards ──────────────────────────────────────────

test.describe("Travel quote-lines API — guards", () => {
  test("GET /quotes/:id/lines without auth → 401/403", async ({ request }) => {
    if (!parentQuoteId) test.skip(true, "no parent quote (beforeAll did not seed)");
    const res = await request.get(`${BASE_URL}/api/travel/quotes/${parentQuoteId}/lines`, {
      timeout: REQUEST_TIMEOUT,
    });
    expect([401, 403]).toContain(res.status());
  });

  test("GET /quotes/9999999/lines (bogus id) → 404 QUOTE_NOT_FOUND", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token) test.skip(true, "yasin@travelstall.in not seeded");
    const res = await get(request, token, "/api/travel/quotes/9999999/lines");
    expect(res.status()).toBe(404);
    expect((await res.json()).code).toBe("QUOTE_NOT_FOUND");
  });

  test("GET /quotes/:id/lines with non-numeric id → 400 INVALID_ID", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token) test.skip(true, "no token");
    const res = await get(request, token, "/api/travel/quotes/not-a-number/lines");
    expect(res.status()).toBe(400);
    expect((await res.json()).code).toBe("INVALID_ID");
  });
});

// ─── List (empty + populated) + happy-path POST ───────────────────────

test.describe("Travel quote-lines API — list + create", () => {
  test("GET /quotes/:id/lines on a fresh parent returns empty array", async ({ request }) => {
    const token = await getTravelAdmin(request);
    expect(token, "yasin@travelstall.in must be seeded").toBeTruthy();
    expect(parentQuoteId, "parent quote must be created in beforeAll").toBeTruthy();

    const res = await get(request, token, `/api/travel/quotes/${parentQuoteId}/lines`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.lines)).toBe(true);
    expect(body.lines).toHaveLength(0);
    expect(body.total).toBe(0);
  });

  test("POST /lines creates a hotel line; amount = qty * unitPrice (server-computed)", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token || !parentQuoteId) test.skip(true, "parent quote missing");

    const res = await post(request, token, `/api/travel/quotes/${parentQuoteId}/lines`, {
      lineType: "hotel",
      description: `${RUN_TAG} Haram view 7n`,
      quantity: 2,
      unitPrice: 45000,
      // currency intentionally omitted — should fall back to parent's INR
    });
    expect(res.status(), `create line: ${await res.text()}`).toBe(201);
    const body = await res.json();
    expect(body.id).toBeTruthy();
    expect(body.lineType).toBe("hotel");
    expect(body.description).toBe(`${RUN_TAG} Haram view 7n`);
    expect(Number(body.quantity)).toBe(2);
    expect(Number(body.unitPrice)).toBe(45000);
    // Cardinal invariant — amount is qty * unitPrice, NOT whatever the
    // body asked for.
    expect(Number(body.amount)).toBe(90000);
    // Currency fallback to parent's INR.
    expect(body.currency).toBe("INR");
  });

  test("POST /lines validation: missing description → 400 MISSING_FIELDS", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token || !parentQuoteId) test.skip(true, "no parent");
    const res = await post(request, token, `/api/travel/quotes/${parentQuoteId}/lines`, {
      lineType: "flight",
      unitPrice: 25000,
      // description missing
    });
    expect(res.status()).toBe(400);
    expect((await res.json()).code).toBe("MISSING_FIELDS");
  });

  test("POST /lines validation: invalid lineType → 400 INVALID_LINE_TYPE", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token || !parentQuoteId) test.skip(true, "no parent");
    const res = await post(request, token, `/api/travel/quotes/${parentQuoteId}/lines`, {
      lineType: "spaceship",
      description: `${RUN_TAG} bad type`,
      unitPrice: 1000,
    });
    expect(res.status()).toBe(400);
    expect((await res.json()).code).toBe("INVALID_LINE_TYPE");
  });

  test("POST /lines validation: negative unitPrice → 400 INVALID_AMOUNT", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token || !parentQuoteId) test.skip(true, "no parent");
    const res = await post(request, token, `/api/travel/quotes/${parentQuoteId}/lines`, {
      lineType: "service",
      description: `${RUN_TAG} negative-price`,
      unitPrice: -50,
    });
    expect(res.status()).toBe(400);
    expect((await res.json()).code).toBe("INVALID_AMOUNT");
  });
});

// ─── PUT amount-recompute branches ────────────────────────────────────

test.describe("Travel quote-lines API — PUT recomputes amount", () => {
  let editLineId = null;

  test("seed a second line for PUT exercising", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token || !parentQuoteId) test.skip(true, "no parent");
    const res = await post(request, token, `/api/travel/quotes/${parentQuoteId}/lines`, {
      lineType: "flight",
      description: `${RUN_TAG} BLR-JED economy`,
      quantity: 1,
      unitPrice: 30000,
    });
    expect(res.status()).toBe(201);
    editLineId = (await res.json()).id;
    expect(editLineId).toBeTruthy();
  });

  test("PUT quantity-only recomputes amount = newQty * existingUnitPrice", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token || !parentQuoteId || !editLineId) test.skip(true, "no edit line");
    const res = await put(
      request,
      token,
      `/api/travel/quotes/${parentQuoteId}/lines/${editLineId}`,
      { quantity: 3 },
    );
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Number(body.quantity)).toBe(3);
    // unitPrice stayed at 30000 → amount must be 90000.
    expect(Number(body.amount)).toBe(90000);
  });

  test("PUT unitPrice-only recomputes amount = existingQty * newUnitPrice", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token || !parentQuoteId || !editLineId) test.skip(true, "no edit line");
    const res = await put(
      request,
      token,
      `/api/travel/quotes/${parentQuoteId}/lines/${editLineId}`,
      { unitPrice: 40000 },
    );
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Number(body.unitPrice)).toBe(40000);
    // quantity stayed at 3 (set by the previous PUT) → amount must be 120000.
    expect(Number(body.amount)).toBe(120000);
  });
});

// ─── DELETE + totalAmount recompute on parent ─────────────────────────

test.describe("Travel quote-lines API — DELETE + parent totalAmount", () => {
  test("Parent totalAmount reflects the sum of surviving lines after writes", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token || !parentQuoteId) test.skip(true, "no parent");
    // Re-fetch the parent quote — should reflect the sum of all lines
    // POSTed/PUT-edited above. After:
    //   - hotel line: 2 * 45000 = 90000
    //   - flight line: 3 * 40000 = 120000
    // totalAmount = 210000. The route's recomputeQuoteTotal is called
    // after every line write, so the quote header is current.
    const res = await get(request, token, `/api/travel/quotes/${parentQuoteId}`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    // Fetch lines independently + assert the parent's totalAmount matches
    // their sum (this is what recomputeQuoteTotal guarantees).
    const linesRes = await get(request, token, `/api/travel/quotes/${parentQuoteId}/lines`);
    expect(linesRes.status()).toBe(200);
    const linesBody = await linesRes.json();
    const lineSum = linesBody.lines.reduce(
      (acc, l) => acc + Number(l.amount || 0),
      0,
    );
    expect(Number(body.totalAmount)).toBe(lineSum);
    expect(lineSum).toBeGreaterThan(0);
  });

  test("DELETE /lines/:lineId returns 204; subsequent GET excludes it", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token || !parentQuoteId) test.skip(true, "no parent");
    // Pick any line to delete.
    const listRes = await get(request, token, `/api/travel/quotes/${parentQuoteId}/lines`);
    const listBody = await listRes.json();
    expect(listBody.lines.length).toBeGreaterThan(0);
    const victim = listBody.lines[0];

    const delRes = await del(
      request,
      token,
      `/api/travel/quotes/${parentQuoteId}/lines/${victim.id}`,
    );
    expect(delRes.status()).toBe(204);

    const afterRes = await get(request, token, `/api/travel/quotes/${parentQuoteId}/lines`);
    const afterBody = await afterRes.json();
    expect(afterBody.lines.some((l) => l.id === victim.id)).toBe(false);
  });
});

// ─── Duplicate quote clones lines ──────────────────────────────────────

test.describe("Travel quote-lines API — duplicate clones lines", () => {
  test("POST /quotes/:id/duplicate then GET lines on new quote returns identical set", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token || !parentQuoteId) test.skip(true, "no parent");

    // Snapshot the source's lines first.
    const srcLinesRes = await get(request, token, `/api/travel/quotes/${parentQuoteId}/lines`);
    expect(srcLinesRes.status()).toBe(200);
    const srcLines = (await srcLinesRes.json()).lines;
    expect(srcLines.length).toBeGreaterThan(0);

    // Duplicate.
    const dupRes = await post(request, token, `/api/travel/quotes/${parentQuoteId}/duplicate`, {});
    expect(dupRes.status(), `duplicate: ${await dupRes.text()}`).toBe(201);
    const dupBody = await dupRes.json();
    duplicateQuoteId = dupBody.id;
    expect(duplicateQuoteId).toBeTruthy();
    expect(duplicateQuoteId).not.toBe(parentQuoteId);
    expect(dupBody.status).toBe("Draft");

    // The duplicate's lines should match the source's count + per-line
    // description + amount (createMany clone path inside the duplicate
    // route).
    const dupLinesRes = await get(request, token, `/api/travel/quotes/${duplicateQuoteId}/lines`);
    expect(dupLinesRes.status()).toBe(200);
    const dupLines = (await dupLinesRes.json()).lines;
    expect(dupLines).toHaveLength(srcLines.length);

    // Sort both by description so cross-row comparison is order-independent.
    const sortByDesc = (a, b) => String(a.description).localeCompare(String(b.description));
    const srcSorted = [...srcLines].sort(sortByDesc);
    const dupSorted = [...dupLines].sort(sortByDesc);
    for (let i = 0; i < srcSorted.length; i++) {
      expect(dupSorted[i].description).toBe(srcSorted[i].description);
      expect(Number(dupSorted[i].amount)).toBe(Number(srcSorted[i].amount));
      expect(dupSorted[i].lineType).toBe(srcSorted[i].lineType);
      // Cloned rows must NOT share the source row's id — they're fresh rows.
      expect(dupSorted[i].id).not.toBe(srcSorted[i].id);
    }
  });
});

// ─── Quote-list slim-shape opt-in (#920 slice S3 — FR-3.5) ────────────
//
// Scope addition: backend/routes/travel_quotes.js's `GET /quotes` list
// endpoint gained a `?fields=summary` opt-in. Pinned here alongside the
// existing quote-lines coverage because they share the same parent
// route file + the beforeAll/afterAll quote seed. Default shape
// unchanged — the slim path drops nothing of consequence on TravelQuote
// (no @db.Text columns on the base model), but the contract pin
// guarantees the projection set + asserts the round-trip works on the
// live stack.

test.describe("Travel quotes list — slim-shape opt-in (#920 S3)", () => {
  test("GET /quotes?fields=summary returns slim projection", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token || !parentQuoteId) test.skip(true, "no parent quote seeded");
    const res = await get(request, token, "/api/travel/quotes?fields=summary&subBrand=tmc");
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.quotes)).toBe(true);
    if (body.quotes.length === 0) test.skip(true, "no quotes for this sub-brand");
    for (const q of body.quotes) {
      // Slim keys present.
      expect(q).toHaveProperty("id");
      expect(q).toHaveProperty("subBrand");
      expect(q).toHaveProperty("contactId");
      expect(q).toHaveProperty("status");
      // Body still bounded — pin via positive-shape (the projection registry
      // determines the shape; the assertion forbids drift via unexpected keys).
      const allowed = new Set([
        "id", "subBrand", "contactId", "status",
        "totalAmount", "currency", "validUntil", "createdAt",
      ]);
      for (const k of Object.keys(q)) {
        expect(allowed.has(k), `unexpected key "${k}" on slim TravelQuote shape`).toBe(true);
      }
    }
  });

  test("GET /quotes (default shape) ships full TravelQuote row", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token || !parentQuoteId) test.skip(true, "no parent quote seeded");
    const res = await get(request, token, "/api/travel/quotes?subBrand=tmc");
    expect(res.status()).toBe(200);
    const body = await res.json();
    if (body.quotes.length === 0) test.skip(true, "no quotes");
    const q = body.quotes[0];
    // Default-shape keys include updatedAt + tenantId that the slim
    // projection drops.
    expect(q).toHaveProperty("updatedAt");
    expect(q).toHaveProperty("tenantId");
  });
});
