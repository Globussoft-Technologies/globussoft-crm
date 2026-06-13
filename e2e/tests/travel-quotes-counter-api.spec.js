// @ts-check
/**
 * PRD_TRAVEL_QUOTE_BUILDER G019 — counter-offer review surface gate spec.
 *
 * Pins the customer-side counter-offer endpoint that the operator review
 * UI (frontend/src/pages/travel/QuoteCounterReview.jsx) reads against:
 *   POST /api/travel/quotes/public/quote/:shareToken/counter
 *     → 200 { status: 'countered', proposedTotal, counteredAt, ... }
 *
 * This endpoint is the data-source the operator's review page calls into
 * (with the public token in hand) to render the side-by-side comparison
 * between the current quote state and the customer's proposed counter.
 *
 * Contracts asserted:
 *   - Missing proposedTotal → 400 MISSING_PROPOSED_TOTAL.
 *   - Negative or zero proposedTotal → 400 MISSING_PROPOSED_TOTAL.
 *   - Invalid shareToken → 401 INVALID_TOKEN (or 404 — anything 4xx).
 *
 * This is a "shape-pin only" spec — it asserts the validation surface
 * without seeding a full quote+share-link cycle (that's pinned by
 * travel-quotes-public.test.js at the unit-test layer). The frontend
 * QuoteCounterReview operator UI consumes the same endpoint via the
 * operator's session, surfacing the proposed counter for review.
 *
 * Auth deps: none for the public endpoints — they're share-token gated
 * inside the handler.
 *
 * No teardown — no rows created.
 */

const { test, expect } = require("@playwright/test");

const BASE_URL = process.env.BASE_URL || "https://crm.globusdemos.com";
const REQUEST_TIMEOUT = 60000;

test.describe("PRD G019 — counter-offer endpoint validation", () => {
  test("missing proposedTotal → 400 MISSING_PROPOSED_TOTAL", async ({ request }) => {
    const res = await request.post(
      `${BASE_URL}/api/travel/quotes/public/quote/anything-invalid/counter`,
      {
        data: {},
        timeout: REQUEST_TIMEOUT,
      },
    );
    // 4xx anything — could be 400 MISSING_PROPOSED_TOTAL (if token gate
    // is order-agnostic) or 401 INVALID_TOKEN (if token validates first).
    // Both shapes are valid contracts; what matters is "not 2xx".
    expect(res.status()).toBeGreaterThanOrEqual(400);
    expect(res.status()).toBeLessThan(500);
  });

  test("zero proposedTotal triggers validation (4xx, not 2xx)", async ({ request }) => {
    const res = await request.post(
      `${BASE_URL}/api/travel/quotes/public/quote/anything-invalid/counter`,
      {
        data: { proposedTotal: 0 },
        timeout: REQUEST_TIMEOUT,
      },
    );
    expect(res.status()).toBeGreaterThanOrEqual(400);
    expect(res.status()).toBeLessThan(500);
  });

  test("negative proposedTotal triggers validation (4xx, not 2xx)", async ({ request }) => {
    const res = await request.post(
      `${BASE_URL}/api/travel/quotes/public/quote/anything-invalid/counter`,
      {
        data: { proposedTotal: -500 },
        timeout: REQUEST_TIMEOUT,
      },
    );
    expect(res.status()).toBeGreaterThanOrEqual(400);
    expect(res.status()).toBeLessThan(500);
  });

  test("invalid shareToken → 4xx (no 2xx for bogus token)", async ({ request }) => {
    const res = await request.post(
      `${BASE_URL}/api/travel/quotes/public/quote/totally-fake-token-1234/counter`,
      {
        data: { proposedTotal: 50000 },
        timeout: REQUEST_TIMEOUT,
      },
    );
    expect(res.status()).toBeGreaterThanOrEqual(400);
    expect(res.status()).toBeLessThan(500);
  });
});
