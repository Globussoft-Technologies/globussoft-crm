// @ts-check
/**
 * Gate spec — Travel tenant Pipeline + PipelineStage + WinLossReason seed contract.
 *
 * Pins the seed-travel.js Section 4 ("Pipeline + lost-reason taxonomies").
 * Read-only verification — no entity creation here, no afterAll cleanup.
 * The taxonomies are LOCKED per PRD §4.1 + Q10; any drift here is a
 * regression on the locked decision.
 *
 * Covered:
 *   - /api/pipelines returns "Travel Default Pipeline" with isDefault: true
 *   - /api/pipeline_stages returns exactly 8 stages, names + order match
 *     the Q10-locked taxonomy
 *   - Stage positions are 0..7 contiguous
 *   - /api/win-loss/reasons returns exactly 8 type=lost rows matching
 *     the Q10-locked taxonomy (no type=won rows per PRD §4.1)
 *   - Unauthenticated access → 401/403
 *
 * Idempotency of the seed is verified at the unit level via the guards
 * in seedPipelineTaxonomies (single-shot findFirst); spec-level we just
 * pin the post-seed contract.
 *
 * Auth: yasin@travelstall.in (admin on the travel-stall tenant).
 */

const { test, expect } = require("@playwright/test");

test.describe.configure({ mode: "serial" });

const BASE_URL = process.env.BASE_URL || "https://crm.globusdemos.com";
const REQUEST_TIMEOUT = 60000;

// Q10-locked taxonomies — DO NOT EDIT WITHOUT REVISITING PRD §4.1 + Q10.
const EXPECTED_STAGES = [
  "New",
  "Diagnostic Complete",
  "Qualifying",
  "Quoted",
  "Negotiating",
  "Won",
  "Lost",
  "Dormant",
];
const EXPECTED_LOST_REASONS = [
  "Price",
  "No response",
  "Chose competitor",
  "Wrong requirement",
  "Timing issue",
  "Budget issue",
  "Trust issue",
  "Duplicate enquiry",
];

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
  return retryOn5xx(() =>
    request.get(`${BASE_URL}${path}`, { headers: headers(token), timeout: REQUEST_TIMEOUT }),
  );
}

test.describe("Travel seed taxonomy — Pipeline (PRD §4.1 + Q10)", () => {
  test("GET /api/pipelines returns 'Travel Default Pipeline' with isDefault: true", async ({ request }) => {
    const token = await getTravelAdmin(request);
    expect(token, "yasin@travelstall.in should be seeded").toBeTruthy();
    const res = await get(request, token, "/api/pipelines");
    expect(res.status()).toBe(200);
    const pipelines = await res.json();
    expect(Array.isArray(pipelines)).toBe(true);

    const def = pipelines.find((p) => p.isDefault === true);
    expect(def, "exactly one default pipeline must exist for travel tenant").toBeTruthy();
    expect(def.name).toBe("Travel Default Pipeline");
    expect(typeof def.description).toBe("string");
    expect(def.description).toContain("PRD §4.1");
  });

  test("GET /api/pipelines unauthenticated → 401/403", async ({ request }) => {
    const res = await request.get(`${BASE_URL}/api/pipelines`, { timeout: REQUEST_TIMEOUT });
    expect([401, 403]).toContain(res.status());
  });
});

test.describe("Travel seed taxonomy — PipelineStage (Q10 locked order)", () => {
  test("GET /api/pipeline_stages returns exactly 8 stages in Q10 locked order", async ({ request }) => {
    const token = await getTravelAdmin(request);
    expect(token).toBeTruthy();
    const res = await get(request, token, "/api/pipeline_stages");
    expect(res.status()).toBe(200);
    const stages = await res.json();
    expect(Array.isArray(stages)).toBe(true);
    expect(stages.length, `expected exactly 8 stages, got ${stages.length}`).toBe(8);

    // Stages must come back position-ordered (the route's orderBy is position asc).
    const names = stages.map((s) => s.name);
    expect(names).toEqual(EXPECTED_STAGES);
  });

  test("Stage positions are 0..7 contiguous (no gaps, no duplicates)", async ({ request }) => {
    const token = await getTravelAdmin(request);
    expect(token).toBeTruthy();
    const res = await get(request, token, "/api/pipeline_stages");
    expect(res.status()).toBe(200);
    const stages = await res.json();
    const positions = stages.map((s) => s.position).sort((a, b) => a - b);
    expect(positions).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  test("Each stage has a non-empty color string", async ({ request }) => {
    const token = await getTravelAdmin(request);
    expect(token).toBeTruthy();
    const res = await get(request, token, "/api/pipeline_stages");
    expect(res.status()).toBe(200);
    const stages = await res.json();
    for (const s of stages) {
      expect(typeof s.color).toBe("string");
      expect(s.color.length).toBeGreaterThan(0);
    }
  });
});

test.describe("Travel seed taxonomy — WinLossReason (Q10 locked, lost-only per PRD §4.1)", () => {
  test("GET /api/win-loss/reasons returns 8 type=lost rows matching Q10 taxonomy", async ({ request }) => {
    const token = await getTravelAdmin(request);
    expect(token).toBeTruthy();
    const res = await get(request, token, "/api/win-loss/reasons");
    expect(res.status()).toBe(200);
    const reasons = await res.json();
    expect(Array.isArray(reasons)).toBe(true);

    const lost = reasons.filter((r) => r.type === "lost");
    expect(lost.length, `expected exactly 8 lost reasons, got ${lost.length}`).toBe(8);

    const lostNames = lost.map((r) => r.reason).sort();
    expect(lostNames).toEqual([...EXPECTED_LOST_REASONS].sort());
  });

  test("No type=won reasons are seeded (PRD §4.1 only taxonomises lost)", async ({ request }) => {
    const token = await getTravelAdmin(request);
    expect(token).toBeTruthy();
    const res = await get(request, token, "/api/win-loss/reasons");
    expect(res.status()).toBe(200);
    const reasons = await res.json();
    const won = reasons.filter((r) => r.type === "won");
    expect(won.length, "PRD §4.1 forbids seeding won-reasons").toBe(0);
  });
});
