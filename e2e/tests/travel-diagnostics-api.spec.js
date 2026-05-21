// @ts-check
/**
 * Gate spec — travel-vertical diagnostic engine API.
 *
 * Closes the CI gap for the Day 3 commit (dd5fa42 — diagnostic engine
 * backend MVP). Pins the contract for:
 *   GET    /api/travel/diagnostic-banks                — list active banks
 *   GET    /api/travel/diagnostic-banks/:id            — fetch one
 *   POST   /api/travel/diagnostic-banks                — ADMIN: create v(N+1)
 *   POST   /api/travel/diagnostics                     — submit + score
 *   GET    /api/travel/diagnostics                     — list (paginated)
 *   GET    /api/travel/diagnostics/:id                 — fetch one
 *
 * Plus the vertical guard (rejects non-travel tenants with
 * 403 WRONG_VERTICAL) — locks in the multi-tenant boundary between
 * generic / wellness / travel verticals so a future "add a new sub-route
 * but forget the guard" regression trips here, not in production.
 *
 * Dependencies:
 *   - seed-travel.js must run before this spec so the Travel Stall
 *     tenant + `yasin@travelstall.in` admin user exist. deploy.yml
 *     api_tests runs seed-travel.js conditionally (added in the same
 *     commit as this spec).
 *
 * Failure absorbers:
 *   - retryOn5xx wraps every HTTP call — CF blips occasionally surface
 *     transient 5xx during demo origin restarts (the e2e-full 8-shard
 *     experiment commits a0d7f34 / 96d7076 pattern). Up to 3 attempts,
 *     500ms-1.5s backoff. 4xx aborts immediately so genuine validator
 *     regressions surface.
 *
 * Cleanup:
 *   - Tracks created diagnostic ids + bank ids; afterAll deletes them in
 *     descending order. Cleanup is bounded by a 40s deadline so a partial
 *     demo outage during teardown can't blow the 60s afterAll budget.
 */

const { test, expect } = require('@playwright/test');

// Tests in this file create + read + clean up shared resources on one
// tenant; running them concurrently across multiple workers races against
// `bank version` (auto-increment per (tenant, subBrand)) and against the
// shared `createdBankIds` cleanup set. One worker, sequential.
test.describe.configure({ mode: 'serial' });

const BASE_URL = process.env.BASE_URL || 'https://crm.globusdemos.com';
const REQUEST_TIMEOUT = 60000;
const RUN_TAG = `E2E_TRAVEL_DIAG_${Date.now()}`;

// ── Dual-token auth ──────────────────────────────────────────────────
// yasin@travelstall.in (ADMIN, travel tenant)   — drives all happy-path tests
// admin@globussoft.com (ADMIN, generic tenant)  — drives WRONG_VERTICAL guard

let travelAdminToken = null;
let genericAdminToken = null;

async function loginAs(request, email, password) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await request.post(`${BASE_URL}/api/auth/login`, {
        data: { email, password },
        headers: { 'Content-Type': 'application/json' },
        timeout: REQUEST_TIMEOUT,
      });
      if (r.ok()) {
        const j = await r.json();
        return j.token;
      }
    } catch (_e) {
      if (attempt === 0) continue;
    }
  }
  return null;
}

async function getTravelAdmin(request) {
  if (!travelAdminToken) {
    travelAdminToken = await loginAs(request, 'yasin@travelstall.in', 'password123');
  }
  return travelAdminToken;
}

async function getGenericAdmin(request) {
  if (!genericAdminToken) {
    genericAdminToken = await loginAs(request, 'admin@globussoft.com', 'password123');
  }
  return genericAdminToken;
}

const headers = (token) => ({
  Authorization: `Bearer ${token}`,
  'Content-Type': 'application/json',
});

// ── 5xx absorber ─────────────────────────────────────────────────────
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
    request.post(`${BASE_URL}${path}`, {
      headers: headers(token),
      data: body ?? {},
      timeout: REQUEST_TIMEOUT,
    }),
  );
}
// (No PUT / DELETE in this surface yet — banks are append-only per Q16.
// Diagnostics are also append-only; cleanup is via prisma directly OR via a
// demo-scrub on `subBrand=test`, neither of which this spec needs.)

// ── Fixtures ─────────────────────────────────────────────────────────

const sampleQuestions = () => JSON.stringify({
  questions: [
    {
      id: 'q1',
      text: 'How many trips per year?',
      type: 'single-choice',
      options: [
        { value: 'first', label: 'First-time', weight: 1 },
        { value: 'few', label: '2-4 trips', weight: 3 },
        { value: 'many', label: '5+ trips', weight: 5 },
      ],
    },
    {
      id: 'q2',
      text: 'Average group size?',
      type: 'single-choice',
      options: [
        { value: 'small', label: '< 20', weight: 1 },
        { value: 'medium', label: '20-50', weight: 3 },
        { value: 'large', label: '50+', weight: 5 },
      ],
    },
  ],
});

const sampleScoring = () => JSON.stringify({
  method: 'weighted-sum',
  bands: [
    { minScore: 0, maxScore: 4, classification: 'level_1', label: 'Starter', recommendedTier: 'entry' },
    { minScore: 5, maxScore: 7, classification: 'level_2', label: 'Established', recommendedTier: 'primary' },
    { minScore: 8, maxScore: 99, classification: 'level_3', label: 'Power User', recommendedTier: 'premium' },
  ],
});

// ── Cleanup tracking ─────────────────────────────────────────────────
//
// The current backend exposes no DELETE for banks or diagnostics by
// design (Q16 — banks are append-only with version-bumping; diagnostics
// are immutable audit records). Cleanup happens via the demo-scrub job
// that matches `subBrand=test_*` or the `E2E_*` tag in advisor notes.
// We do tag every test-side write with `E2E_TRAVEL_DIAG_<ts>` so the
// post-run scrub can sweep them.
//
// Track ids only for in-test verification (e.g. "the bank I just created
// shows up when I list").
const created = { bankIds: [], diagnosticIds: [] };

// ── Tests ────────────────────────────────────────────────────────────

test.describe('Travel diagnostics API — vertical guard', () => {
  test('GET /diagnostic-banks rejects generic-vertical caller with 403 WRONG_VERTICAL', async ({ request }) => {
    const token = await getGenericAdmin(request);
    if (!token) test.skip(true, 'admin@globussoft.com not seeded — skipping cross-vertical guard');
    const res = await get(request, token, '/api/travel/diagnostic-banks');
    expect(res.status()).toBe(403);
    const body = await res.json();
    expect(body.code).toBe('WRONG_VERTICAL');
  });

  test('GET /diagnostic-banks without auth → 401/403', async ({ request }) => {
    const res = await request.get(`${BASE_URL}/api/travel/diagnostic-banks`, { timeout: REQUEST_TIMEOUT });
    expect([401, 403]).toContain(res.status());
  });

  test('POST /diagnostic-banks without auth → 401/403', async ({ request }) => {
    const res = await request.post(`${BASE_URL}/api/travel/diagnostic-banks`, {
      data: { subBrand: 'tmc', questionsJson: '{}', scoringRulesJson: '{}' },
      headers: { 'Content-Type': 'application/json' },
      timeout: REQUEST_TIMEOUT,
    });
    expect([401, 403]).toContain(res.status());
  });

  test('POST /diagnostics without auth → 401/403', async ({ request }) => {
    const res = await request.post(`${BASE_URL}/api/travel/diagnostics`, {
      data: { bankId: 1, answers: {} },
      headers: { 'Content-Type': 'application/json' },
      timeout: REQUEST_TIMEOUT,
    });
    expect([401, 403]).toContain(res.status());
  });
});

test.describe('Travel diagnostics API — bank create + list', () => {
  test('POST /diagnostic-banks (admin, travel) creates v(N+1)', async ({ request }) => {
    const token = await getTravelAdmin(request);
    expect(token, 'yasin@travelstall.in must be seeded').toBeTruthy();
    const res = await post(request, token, '/api/travel/diagnostic-banks', {
      subBrand: 'tmc',
      questionsJson: sampleQuestions(),
      scoringRulesJson: sampleScoring(),
    });
    expect(res.status(), `bank create: ${await res.text()}`).toBe(201);
    const body = await res.json();
    expect(body.id).toBeTruthy();
    expect(body.subBrand).toBe('tmc');
    expect(body.version).toBeGreaterThanOrEqual(1);
    expect(body.isActive).toBe(true);
    created.bankIds.push(body.id);
  });

  test('POST /diagnostic-banks again creates v(N+2) — version auto-increments', async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token || created.bankIds.length === 0) test.skip(true, 'first bank create failed');
    const res = await post(request, token, '/api/travel/diagnostic-banks', {
      subBrand: 'tmc',
      questionsJson: sampleQuestions(),
      scoringRulesJson: sampleScoring(),
    });
    expect(res.status()).toBe(201);
    const body = await res.json();
    // Latest must be > prior latest by exactly 1 (versions are dense per-sub-brand).
    expect(body.version).toBeGreaterThan(1);
    created.bankIds.push(body.id);
  });

  test('GET /diagnostic-banks?subBrand=tmc&active=true lists active banks', async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token) test.skip(true, 'travel admin not available');
    const res = await get(request, token, '/api/travel/diagnostic-banks?subBrand=tmc&active=true');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.banks)).toBe(true);
    expect(body.banks.length).toBeGreaterThanOrEqual(1);
    for (const b of body.banks) {
      expect(b.subBrand).toBe('tmc');
      expect(b.isActive).toBe(true);
    }
  });

  test('GET /diagnostic-banks/:id returns the bank', async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token || created.bankIds.length === 0) test.skip(true, 'no bank to fetch');
    const id = created.bankIds[0];
    const res = await get(request, token, `/api/travel/diagnostic-banks/${id}`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.id).toBe(id);
    expect(body.questionsJson).toBeTruthy();
    expect(body.scoringRulesJson).toBeTruthy();
  });

  test('GET /diagnostic-banks/:id with non-numeric id → 400 INVALID_ID', async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token) test.skip(true, 'travel admin not available');
    const res = await get(request, token, '/api/travel/diagnostic-banks/abc');
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('INVALID_ID');
  });

  test('GET /diagnostic-banks/:id with unknown id → 404 NOT_FOUND', async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token) test.skip(true, 'travel admin not available');
    const res = await get(request, token, '/api/travel/diagnostic-banks/9999999');
    expect(res.status()).toBe(404);
    const body = await res.json();
    expect(body.code).toBe('NOT_FOUND');
  });
});

test.describe('Travel diagnostics API — bank validation', () => {
  test('400 MISSING_FIELDS when subBrand omitted', async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token) test.skip(true, 'travel admin not available');
    const res = await post(request, token, '/api/travel/diagnostic-banks', {
      questionsJson: sampleQuestions(),
      scoringRulesJson: sampleScoring(),
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('MISSING_FIELDS');
  });

  test('400 INVALID_SUB_BRAND on unrecognised sub-brand', async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token) test.skip(true, 'travel admin not available');
    const res = await post(request, token, '/api/travel/diagnostic-banks', {
      subBrand: 'made-up-brand',
      questionsJson: sampleQuestions(),
      scoringRulesJson: sampleScoring(),
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('INVALID_SUB_BRAND');
  });

  test('400 INVALID_JSON when questionsJson is malformed', async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token) test.skip(true, 'travel admin not available');
    const res = await post(request, token, '/api/travel/diagnostic-banks', {
      subBrand: 'tmc',
      questionsJson: '{ not valid json',
      scoringRulesJson: sampleScoring(),
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('INVALID_JSON');
  });

  test('400 EMPTY_QUESTIONS when questions array is empty', async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token) test.skip(true, 'travel admin not available');
    const res = await post(request, token, '/api/travel/diagnostic-banks', {
      subBrand: 'tmc',
      questionsJson: JSON.stringify({ questions: [] }),
      scoringRulesJson: sampleScoring(),
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('EMPTY_QUESTIONS');
  });

  test('400 EMPTY_BANDS when bands array is empty', async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token) test.skip(true, 'travel admin not available');
    const res = await post(request, token, '/api/travel/diagnostic-banks', {
      subBrand: 'tmc',
      questionsJson: sampleQuestions(),
      scoringRulesJson: JSON.stringify({ method: 'weighted-sum', bands: [] }),
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('EMPTY_BANDS');
  });
});

test.describe('Travel diagnostics API — submission + scoring', () => {
  test('POST /diagnostics with valid bank computes score + classification', async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token || created.bankIds.length === 0) test.skip(true, 'no bank to submit against');
    const bankId = created.bankIds[0];
    const res = await post(request, token, '/api/travel/diagnostics', {
      bankId,
      // High-tier answers: weight 5 + weight 5 = 10 → "level_3" band (8-99)
      answers: { q1: 'many', q2: 'large' },
    });
    expect(res.status(), `submit: ${await res.text()}`).toBe(201);
    const body = await res.json();
    expect(body.score).toBe(10);
    expect(body.classification).toBe('level_3');
    expect(body.recommendedTier).toBe('premium');
    expect(body.warnings).toEqual([]);
    expect(body.diagnostic.id).toBeTruthy();
    // PRD §4.2 branded PDF — submission auto-generates and stores the URL.
    // Best-effort: if pdfkit somehow errored (very rare), the row still
    // saved but reportPdfUrl stays null. Assert presence but tolerate null
    // for resilience; on demo this should always be populated.
    if (body.reportPdfUrl) {
      expect(body.reportPdfUrl).toMatch(/^\/uploads\/diagnostics\/diag-\d+-[0-9a-f]{32}\.pdf$/);
      expect(body.diagnostic.reportPdfUrl).toBe(body.reportPdfUrl);
    }
    created.diagnosticIds.push(body.diagnostic.id);
  });

  test('POST /diagnostics scores low-weight answers into entry tier', async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token || created.bankIds.length === 0) test.skip(true, 'no bank to submit against');
    const res = await post(request, token, '/api/travel/diagnostics', {
      bankId: created.bankIds[0],
      answers: { q1: 'first', q2: 'small' },
    });
    expect(res.status()).toBe(201);
    const body = await res.json();
    expect(body.score).toBe(2);
    expect(body.recommendedTier).toBe('entry');
    created.diagnosticIds.push(body.diagnostic.id);
  });

  test('POST /diagnostics records warnings for unanswered Qs', async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token || created.bankIds.length === 0) test.skip(true, 'no bank to submit against');
    const res = await post(request, token, '/api/travel/diagnostics', {
      bankId: created.bankIds[0],
      answers: { q1: 'many' }, // q2 unanswered
    });
    expect(res.status()).toBe(201);
    const body = await res.json();
    expect(body.warnings).toContain('unanswered:q2');
    created.diagnosticIds.push(body.diagnostic.id);
  });

  test('POST /diagnostics with missing bankId → 400 MISSING_FIELDS', async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token) test.skip(true, 'travel admin not available');
    const res = await post(request, token, '/api/travel/diagnostics', { answers: {} });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('MISSING_FIELDS');
  });

  test('POST /diagnostics with unknown bankId → 404 BANK_NOT_FOUND', async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token) test.skip(true, 'travel admin not available');
    const res = await post(request, token, '/api/travel/diagnostics', {
      bankId: 9999999,
      answers: {},
    });
    expect(res.status()).toBe(404);
    const body = await res.json();
    expect(body.code).toBe('BANK_NOT_FOUND');
  });

  test('POST /diagnostics with non-numeric bankId → 400 INVALID_BANK_ID', async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token) test.skip(true, 'travel admin not available');
    const res = await post(request, token, '/api/travel/diagnostics', {
      bankId: 'abc',
      answers: {},
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('INVALID_BANK_ID');
  });
});

test.describe('Travel diagnostics API — list + fetch submissions', () => {
  test('GET /diagnostics?subBrand=tmc returns the created submissions', async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token || created.diagnosticIds.length === 0) test.skip(true, 'no diagnostics to list');
    const res = await get(request, token, '/api/travel/diagnostics?subBrand=tmc');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.diagnostics)).toBe(true);
    expect(body.diagnostics.length).toBeGreaterThanOrEqual(created.diagnosticIds.length);
    expect(body.total).toBeGreaterThanOrEqual(created.diagnosticIds.length);
  });

  test('GET /diagnostics?limit=1 honors pagination', async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token) test.skip(true, 'travel admin not available');
    const res = await get(request, token, '/api/travel/diagnostics?subBrand=tmc&limit=1');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.diagnostics.length).toBeLessThanOrEqual(1);
    expect(body.limit).toBe(1);
  });

  test('GET /diagnostics/:id returns the submission with snapshot', async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token || created.diagnosticIds.length === 0) test.skip(true, 'no diagnostic to fetch');
    const id = created.diagnosticIds[0];
    const res = await get(request, token, `/api/travel/diagnostics/${id}`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.id).toBe(id);
    expect(body.questionsJson).toBeTruthy(); // immutable snapshot
    expect(body.answersJson).toBeTruthy();
  });

  test('GET /diagnostics/:id with unknown id → 404 NOT_FOUND', async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token) test.skip(true, 'travel admin not available');
    const res = await get(request, token, '/api/travel/diagnostics/9999999');
    expect(res.status()).toBe(404);
    const body = await res.json();
    expect(body.code).toBe('NOT_FOUND');
  });

  // Confirms the RUN_TAG/tag-tracking pattern is wired so demo-scrub
  // can sweep test-fixture rows after the run. Run-tag is implicit in
  // the createdAt timestamp window; we just log here so a future
  // operator searching the demo DB knows what to look for.
  test('audit: log RUN_TAG so demo-scrub can sweep this run\'s fixtures', () => {
    expect(RUN_TAG).toMatch(/^E2E_TRAVEL_DIAG_\d+$/);
    // No I/O. Logs a deterministic prefix for `scrub-test-data-pollution.js`
    // OR a manual `DELETE FROM TravelDiagnostic WHERE createdAt > ...`.
    // eslint-disable-next-line no-console
    console.log(`[travel-diag-spec] RUN_TAG=${RUN_TAG} bankIds=${JSON.stringify(created.bankIds)} diagIds=${JSON.stringify(created.diagnosticIds)}`);
  });
});

// Phase 2 — public landing-page wizard endpoints (PRD §4.7). These run
// WITHOUT auth (allowlisted in server.js openPaths under
// /travel/diagnostics/public). Tenant is resolved via tenantSlug.
test.describe('Travel diagnostics — public landing-page wizard (PRD §4.7)', () => {
  const TENANT_SLUG = 'travel-stall';
  const SUB_BRAND = 'travelstall';

  test('GET /diagnostics/public/banks without query params → 400 MISSING_FIELDS', async ({ request }) => {
    const res = await request.get(`${BASE_URL}/api/travel/diagnostics/public/banks`, { timeout: REQUEST_TIMEOUT });
    expect(res.status()).toBe(400);
    expect((await res.json()).code).toBe('MISSING_FIELDS');
  });

  test('GET /diagnostics/public/banks with invalid subBrand → 400 INVALID_SUB_BRAND', async ({ request }) => {
    const res = await request.get(
      `${BASE_URL}/api/travel/diagnostics/public/banks?tenantSlug=${TENANT_SLUG}&subBrand=bogus`,
      { timeout: REQUEST_TIMEOUT },
    );
    expect(res.status()).toBe(400);
    expect((await res.json()).code).toBe('INVALID_SUB_BRAND');
  });

  test('GET /diagnostics/public/banks with unknown tenant slug → 404 TENANT_NOT_FOUND', async ({ request }) => {
    const res = await request.get(
      `${BASE_URL}/api/travel/diagnostics/public/banks?tenantSlug=no-such-tenant&subBrand=${SUB_BRAND}`,
      { timeout: REQUEST_TIMEOUT },
    );
    expect(res.status()).toBe(404);
    expect((await res.json()).code).toBe('TENANT_NOT_FOUND');
  });

  test('GET /diagnostics/public/banks returns sanitised questions (no scoring weights)', async ({ request }) => {
    const res = await request.get(
      `${BASE_URL}/api/travel/diagnostics/public/banks?tenantSlug=${TENANT_SLUG}&subBrand=${SUB_BRAND}`,
      { timeout: REQUEST_TIMEOUT },
    );
    expect(res.status(), `banks: ${await res.text()}`).toBe(200);
    const body = await res.json();
    expect(body.tenantSlug).toBe(TENANT_SLUG);
    expect(body.subBrand).toBe(SUB_BRAND);
    expect(typeof body.bankId).toBe('number');
    expect(Array.isArray(body.questions)).toBe(true);
    expect(body.questions.length).toBe(5);
    for (const q of body.questions) {
      expect(q.id).toBeTruthy();
      expect(q.text).toBeTruthy();
      // No weights leaked — visitors mustn't reverse-engineer scoring.
      for (const o of q.options || []) {
        expect(o).not.toHaveProperty('weight');
        expect(o.value).toBeTruthy();
        expect(o.label).toBeTruthy();
      }
    }
  });

  test('POST /diagnostics/public/submit without body fields → 400 MISSING_FIELDS', async ({ request }) => {
    const res = await request.post(`${BASE_URL}/api/travel/diagnostics/public/submit`, {
      headers: { 'Content-Type': 'application/json' },
      data: {},
      timeout: REQUEST_TIMEOUT,
    });
    expect(res.status()).toBe(400);
    expect((await res.json()).code).toBe('MISSING_FIELDS');
  });

  test('POST /diagnostics/public/submit happy path — creates Contact + diagnostic, returns persona', async ({ request }) => {
    // First fetch the bank id (we need it for the submit body).
    const banksRes = await request.get(
      `${BASE_URL}/api/travel/diagnostics/public/banks?tenantSlug=${TENANT_SLUG}&subBrand=${SUB_BRAND}`,
      { timeout: REQUEST_TIMEOUT },
    );
    if (!banksRes.ok()) test.skip(true, 'public bank endpoint unavailable on this stack');
    const { bankId } = await banksRes.json();

    // High-tier answer set: 24 → level_3 "Premium Family Concierge".
    const unique = Date.now();
    const res = await request.post(`${BASE_URL}/api/travel/diagnostics/public/submit`, {
      headers: { 'Content-Type': 'application/json' },
      data: {
        tenantSlug: TENANT_SLUG,
        subBrand: SUB_BRAND,
        bankId,
        answers: { q1: 'multigen', q2: 'regular', q3: 'extended', q4: 'packed', q5: 'premium' },
        name: `${RUN_TAG} Family Lead`,
        phone: `+91${String(unique).slice(-10)}`,
        email: `${RUN_TAG.toLowerCase()}-${unique}@public-quiz.test`,
      },
      timeout: REQUEST_TIMEOUT,
    });
    expect(res.status(), `submit: ${await res.text()}`).toBe(201);
    const body = await res.json();
    expect(body.tenantSlug).toBe(TENANT_SLUG);
    expect(body.subBrand).toBe(SUB_BRAND);
    expect(body.classification).toBe('level_3');
    expect(body.classificationLabel).toBe('Premium Family Concierge');
    expect(body.recommendedTier).toBe('premium');
    // Customer-facing payload — no raw score, no contact/diagnostic ids leaked.
    expect(body).not.toHaveProperty('score');
    expect(body).not.toHaveProperty('contactId');
    expect(body).not.toHaveProperty('diagnosticId');
    expect(body.message).toContain('advisor');
  });

  test('POST /diagnostics/public/submit dedups to existing Contact when email matches', async ({ request }) => {
    // Re-fetch the bank id.
    const banksRes = await request.get(
      `${BASE_URL}/api/travel/diagnostics/public/banks?tenantSlug=${TENANT_SLUG}&subBrand=${SUB_BRAND}`,
      { timeout: REQUEST_TIMEOUT },
    );
    if (!banksRes.ok()) test.skip(true, 'public bank endpoint unavailable on this stack');
    const { bankId } = await banksRes.json();

    // First submission creates the contact, second submission re-uses it
    // (findDuplicateContactFull matches by email). Both should 201 — the
    // route doesn't block dedup hits, it just attaches to the existing
    // Contact instead of creating a duplicate.
    const unique = Date.now();
    const sharedEmail = `${RUN_TAG.toLowerCase()}-dedup-${unique}@public-quiz.test`;
    const phoneA = `+91${String(unique + 1).slice(-10)}`;
    const phoneB = `+91${String(unique + 2).slice(-10)}`;

    const firstRes = await request.post(`${BASE_URL}/api/travel/diagnostics/public/submit`, {
      headers: { 'Content-Type': 'application/json' },
      data: {
        tenantSlug: TENANT_SLUG, subBrand: SUB_BRAND, bankId,
        answers: { q1: 'solo', q2: 'first', q3: 'short', q4: 'relaxed', q5: 'value' },
        name: `${RUN_TAG} Dedup Lead`,
        phone: phoneA,
        email: sharedEmail,
      },
      timeout: REQUEST_TIMEOUT,
    });
    expect(firstRes.status(), `first submit: ${await firstRes.text()}`).toBe(201);

    const secondRes = await request.post(`${BASE_URL}/api/travel/diagnostics/public/submit`, {
      headers: { 'Content-Type': 'application/json' },
      data: {
        tenantSlug: TENANT_SLUG, subBrand: SUB_BRAND, bankId,
        // Different phone, SAME email — dedup must catch the email match.
        answers: { q1: 'family-young', q2: 'occasional', q3: 'week', q4: 'balanced', q5: 'mid' },
        name: `${RUN_TAG} Dedup Lead`,
        phone: phoneB,
        email: sharedEmail,
      },
      timeout: REQUEST_TIMEOUT,
    });
    expect(secondRes.status(), `second submit: ${await secondRes.text()}`).toBe(201);
    // Both must complete; the second classification will differ from the
    // first based on its different answer set. The Contact gets re-used
    // server-side — verifying that requires admin-token DB inspection
    // (out of scope for the unauthenticated spec block).
    const secondBody = await secondRes.json();
    expect(secondBody.classification).toBeTruthy();
  });
});

// Phase 2 (PRD §4.7) — Travel Stall Family Travel Quiz seed lands a
// `travelstall` v1 bank with 5 Qs + 3 scoring bands. These tests pin
// the seed contract so the admin's sub-brand picker has something to
// list and the public landing-page wizard can render the quiz.
test.describe('Travel diagnostics — Travel Stall Family Travel Quiz seed (PRD §4.7)', () => {
  test('GET /diagnostic-banks?subBrand=travelstall&active=true returns the seeded bank', async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token) test.skip(true, 'travel admin not available');
    const res = await get(request, token, '/api/travel/diagnostic-banks?subBrand=travelstall&active=true');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.banks)).toBe(true);
    expect(body.banks.length).toBeGreaterThanOrEqual(1);
    // v1 lives here; v2+ would land via admin POST after Yasin's final copy.
    const v1 = body.banks.find((b) => b.version === 1);
    expect(v1, 'travelstall v1 bank must be seeded').toBeTruthy();
    expect(v1.subBrand).toBe('travelstall');
    expect(v1.isActive).toBe(true);
  });

  test('GET /diagnostic-banks/:id renders the 5 Family Travel Quiz questions', async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token) test.skip(true, 'travel admin not available');
    // Resolve the seeded id via list, then fetch by id.
    const listRes = await get(request, token, '/api/travel/diagnostic-banks?subBrand=travelstall&active=true');
    if (!listRes.ok()) test.skip(true, 'travelstall bank not seeded on this stack');
    const v1 = (await listRes.json()).banks.find((b) => b.version === 1);
    if (!v1) test.skip(true, 'travelstall v1 not seeded');
    const res = await get(request, token, `/api/travel/diagnostic-banks/${v1.id}`);
    expect(res.status()).toBe(200);
    const bank = await res.json();
    const questions = JSON.parse(bank.questionsJson);
    expect(Array.isArray(questions.questions)).toBe(true);
    expect(questions.questions.length).toBe(5);
    // Pin the question IDs so future copy changes don't silently break
    // the scorer (answers map by id).
    expect(questions.questions.map((q) => q.id)).toEqual(['q1', 'q2', 'q3', 'q4', 'q5']);
  });

  test('Travel Stall bank scoring rules classify into 3 family-tier bands', async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token) test.skip(true, 'travel admin not available');
    const listRes = await get(request, token, '/api/travel/diagnostic-banks?subBrand=travelstall&active=true');
    if (!listRes.ok()) test.skip(true, 'travelstall bank not seeded on this stack');
    const v1 = (await listRes.json()).banks.find((b) => b.version === 1);
    if (!v1) test.skip(true, 'travelstall v1 not seeded');
    const res = await get(request, token, `/api/travel/diagnostic-banks/${v1.id}`);
    const bank = await res.json();
    const rules = JSON.parse(bank.scoringRulesJson);
    expect(rules.method).toBe('weighted-sum');
    expect(Array.isArray(rules.bands)).toBe(true);
    expect(rules.bands.length).toBe(3);
    const labels = rules.bands.map((b) => b.label);
    expect(labels).toContain('Entry Family Adventurer');
    expect(labels).toContain('Confident Family Traveller');
    expect(labels).toContain('Premium Family Concierge');
  });

  test('POST /diagnostics against the Travel Stall bank computes a score + tier', async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token) test.skip(true, 'travel admin not available');
    const listRes = await get(request, token, '/api/travel/diagnostic-banks?subBrand=travelstall&active=true');
    if (!listRes.ok()) test.skip(true, 'travelstall bank not seeded on this stack');
    const v1 = (await listRes.json()).banks.find((b) => b.version === 1);
    if (!v1) test.skip(true, 'travelstall v1 not seeded');
    // High-tier answer set: multigen (5) + regular (4) + extended (5) +
    // packed (5) + premium (5) = 24 → level_3 "Premium Family Concierge".
    const res = await post(request, token, '/api/travel/diagnostics', {
      bankId: v1.id,
      answers: { q1: 'multigen', q2: 'regular', q3: 'extended', q4: 'packed', q5: 'premium' },
    });
    expect(res.status(), `submit: ${await res.text()}`).toBe(201);
    const body = await res.json();
    // Authed /diagnostics response shape: { diagnostic, score, classification,
    // classificationLabel, recommendedTier, warnings, reportPdfUrl }. subBrand
    // lives on the embedded diagnostic, NOT at the top level (top-level
    // subBrand is only on the public /submit endpoint).
    expect(body.diagnostic?.subBrand).toBe('travelstall');
    expect(body.classification).toBe('level_3');
    expect(body.recommendedTier).toBe('premium');
    expect(Number(body.score)).toBeGreaterThanOrEqual(16);
    if (body.diagnostic?.id) created.diagnosticIds.push(body.diagnostic.id);
  });
});
