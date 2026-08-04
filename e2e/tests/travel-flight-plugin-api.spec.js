// @ts-check
/**
 * Gate spec - Flight Quotation plugin endpoint (#908 FR-5).
 *
 *   POST /api/v1/flight-plugin/quotes   - X-API-Key auth (externalAuth)
 *   POST /api/v1/flight-plugin/extract-hotel-prices - JWT auth (verifyToken)
 *
 * Pins the auth-gate contract. The keyed happy-path is intentionally NOT
 * exercised with a hardcoded demo key - a real per-advisor key is generated
 * in production (no fake credential is seeded into the repo) - so this spec
 * asserts the unauthenticated + malformed-key behaviour only.
 */
const { test, expect } = require("@playwright/test");

const BASE_URL = process.env.BASE_URL || "https://crm.globusdemos.com";
const REQUEST_TIMEOUT = 60000;
const QUOTES = "/api/v1/flight-plugin/quotes";
const HOTEL_EXTRACT = "/api/v1/flight-plugin/extract-hotel-prices";

function postQuote(request, key, body) {
  return request.post(`${BASE_URL}${QUOTES}`, {
    headers: key
      ? { "X-API-Key": key, "Content-Type": "application/json" }
      : { "Content-Type": "application/json" },
    data: body ?? {},
    timeout: REQUEST_TIMEOUT,
  });
}

function postHotelExtract(request, key, body) {
  return request.post(`${BASE_URL}${HOTEL_EXTRACT}`, {
    headers: key
      ? { "X-API-Key": key, "Content-Type": "application/json" }
      : { "Content-Type": "application/json" },
    data: body ?? {},
    timeout: REQUEST_TIMEOUT,
  });
}

test.describe("Flight plugin quotes API - auth gate", () => {
  test("rejects a request with no API key (401)", async ({ request }) => {
    const r = await postQuote(request, null, { airline: "AI" });
    expect(r.status()).toBe(401);
  });

  test("rejects a malformed API key (401)", async ({ request }) => {
    const r = await postQuote(request, "not-a-key", { airline: "AI" });
    expect(r.status()).toBe(401);
  });
});

test.describe("Flight plugin hotel extraction API - auth gate", () => {
  test("rejects a request with no API key (401)", async ({ request }) => {
    const r = await postHotelExtract(request, null, {});
    expect(r.status()).toBe(401);
  });

  test("rejects a malformed API key (401)", async ({ request }) => {
    const r = await postHotelExtract(request, "not-a-key", {});
    expect(r.status()).toBe(401);
  });
});
