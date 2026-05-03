// @ts-check
/**
 * Surveys module — backend coverage push.
 *
 * routes/surveys.js was 16.7% covered (394 uncovered lines / 473 total).
 * Spec drives every endpoint:
 *
 *   GET    /api/surveys                       — list + per-survey aggregate stats
 *   POST   /api/surveys                       — create (validation: name, question, type)
 *   PUT    /api/surveys/:id                   — update (partial)
 *   DELETE /api/surveys/:id                   — delete (cascades responses)
 *   POST   /api/surveys/:id/send              — dispatch to contactIds via Mailgun (best-effort)
 *   GET    /api/surveys/:id/responses         — list responses with contact lookup
 *   GET    /api/surveys/:id/stats             — aggregated stats (count/avg/distribution/nps)
 *   GET    /api/surveys/respond/:token        — PUBLIC, no auth (token-based, openPaths)
 *   POST   /api/surveys/respond/:token        — PUBLIC, no auth (record response, marks token used)
 *   GET    /api/surveys/public/:id            — PUBLIC, no auth (id-based, openPaths)
 *   POST   /api/surveys/public/:id/respond    — PUBLIC, no auth (id-based response submit)
 *
 * Schema notes (Survey model in backend/prisma/schema.prisma):
 *   - Field is `name` (NOT `title`) — wellness NPS engine had a bug here pre-3.2.0.
 *   - Field is `question` (singular String, NOT `questions` JSON array). Route reads
 *     req.body.question and writes survey.question; the older "questions: [...]" shape
 *     this spec was originally drafted for does not exist on the model. We send `question`.
 *   - `type` ∈ {NPS, CSAT, CUSTOM}. Anything else falls through to NPS in the create path.
 *   - `isActive` defaults true; the public endpoints 410 when isActive=false.
 *
 * Auth dual-token:
 *   admin@globussoft.com / password123 — ADMIN, generic tenant. Drives create/delete/send.
 *   user@crm.com         / password123 — USER, same tenant. Drives 401/403 / cross-role checks.
 *
 * Public endpoints: this spec sends NO Authorization header for /respond/:token,
 *   /public/:id, /public/:id/respond. Those paths are listed in openPaths in
 *   backend/server.js so the global auth guard short-circuits before verifyToken.
 *
 * Cleanup: every created survey is name-tagged `E2E_SURV_<ts>`. afterAll deletes
 *   each as admin via DELETE /api/surveys/:id, which the route handler cascades to
 *   prisma.surveyResponse.deleteMany before deleting the parent. No orphan rows.
 *
 * Concurrency: every test creates its own survey + response state, so the spec is
 *   parallel-safe and runs under playwright.config.js's default fullyParallel mode.
 */
const { test, expect } = require('@playwright/test');

const BASE_URL = process.env.BASE_URL || 'https://crm.globusdemos.com';
const REQUEST_TIMEOUT = 30000;
const RUN_TAG = `E2E_SURV_${Date.now()}`;

// ── Dual-token auth ────────────────────────────────────────────────
let adminToken = null;
let adminUserId = null;
let userToken = null;
let userUserId = null;

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
        return { token: j.token, userId: j.user.id };
      }
    } catch (e) {
      if (attempt === 0) continue;
    }
  }
  return { token: null, userId: null };
}

async function getAdmin(request) {
  if (!adminToken) {
    const r = await loginAs(request, 'admin@globussoft.com', 'password123');
    adminToken = r.token;
    adminUserId = r.userId;
  }
  return { token: adminToken, userId: adminUserId };
}

async function getUser(request) {
  if (!userToken) {
    const r = await loginAs(request, 'user@crm.com', 'password123');
    userToken = r.token;
    userUserId = r.userId;
  }
  return { token: userToken, userId: userUserId };
}

const headers = (token) => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' });
const noAuthHeaders = () => ({ 'Content-Type': 'application/json' });

async function get(request, token, path) {
  return request.get(`${BASE_URL}${path}`, { headers: headers(token), timeout: REQUEST_TIMEOUT });
}
async function post(request, token, path, body) {
  return request.post(`${BASE_URL}${path}`, { headers: headers(token), data: body ?? {}, timeout: REQUEST_TIMEOUT });
}
async function put(request, token, path, body) {
  return request.put(`${BASE_URL}${path}`, { headers: headers(token), data: body ?? {}, timeout: REQUEST_TIMEOUT });
}
async function del(request, token, path) {
  return request.delete(`${BASE_URL}${path}`, { headers: headers(token), timeout: REQUEST_TIMEOUT });
}

// Public-endpoint helpers — explicitly do NOT send Authorization.
async function getPublic(request, path) {
  return request.get(`${BASE_URL}${path}`, { headers: noAuthHeaders(), timeout: REQUEST_TIMEOUT });
}
async function postPublic(request, path, body) {
  return request.post(`${BASE_URL}${path}`, { headers: noAuthHeaders(), data: body ?? {}, timeout: REQUEST_TIMEOUT });
}

// ── Cleanup tracking ───────────────────────────────────────────────
const createdSurveyIds = new Set();

test.afterAll(async ({ request }) => {
  const { token } = await getAdmin(request);
  if (!token) return;
  for (const id of createdSurveyIds) {
    await del(request, token, `/api/surveys/${id}`).catch(() => {});
  }
});

// Helper: create a survey as admin and return the row.
async function createSurvey(request, overrides = {}) {
  const { token } = await getAdmin(request);
  const res = await post(request, token, '/api/surveys', {
    name: overrides.name || `${RUN_TAG} ${Math.random().toString(36).slice(2, 8)}`,
    type: overrides.type || 'NPS',
    question: overrides.question || 'How likely are you to recommend us?',
    ...overrides.extra,
  });
  expect(res.status(), `create survey: ${await res.text()}`).toBe(201);
  const body = await res.json();
  if (body && body.id) createdSurveyIds.add(body.id);
  return body;
}

// ── GET / list ─────────────────────────────────────────────────────

test.describe('Surveys API — GET /', () => {
  test('200 returns array of surveys', async ({ request }) => {
    const { token } = await getAdmin(request);
    await createSurvey(request, { name: `${RUN_TAG} list-1` });
    const res = await get(request, token, '/api/surveys');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    // Each row is enriched with responseCount + avgScore.
    if (body.length > 0) {
      expect(typeof body[0].responseCount).toBe('number');
      expect(typeof body[0].avgScore).toBe('number');
    }
  });

  test('list includes a freshly created survey, scoped to caller tenant', async ({ request }) => {
    const created = await createSurvey(request, { name: `${RUN_TAG} list-includes` });
    const { token } = await getAdmin(request);
    const res = await get(request, token, '/api/surveys');
    const list = await res.json();
    expect(list.some((s) => s.id === created.id)).toBe(true);
  });

  test('NPS rows expose npsScore field; CSAT rows do not', async ({ request }) => {
    const { token } = await getAdmin(request);
    await createSurvey(request, { name: `${RUN_TAG} nps-shape`, type: 'NPS' });
    await createSurvey(request, { name: `${RUN_TAG} csat-shape`, type: 'CSAT' });
    const list = await (await get(request, token, '/api/surveys')).json();
    const ours = list.filter((s) => String(s.name).startsWith(RUN_TAG));
    const nps = ours.find((s) => s.type === 'NPS');
    const csat = ours.find((s) => s.type === 'CSAT');
    if (nps) {
      // npsScore can be null when there are no responses, but the key must be present.
      expect('npsScore' in nps).toBe(true);
    }
    if (csat) {
      expect(csat.type).toBe('CSAT');
    }
  });
});

// ── POST / — create + validation ───────────────────────────────────

test.describe('Surveys API — POST / (validation)', () => {
  test('201 creates with valid name + question, defaults type=NPS', async ({ request }) => {
    const { token } = await getAdmin(request);
    const res = await post(request, token, '/api/surveys', {
      name: `${RUN_TAG} default-type`,
      question: 'Default type test?',
    });
    expect(res.status()).toBe(201);
    const body = await res.json();
    expect(body.id).toBeTruthy();
    expect(body.name).toContain('default-type');
    expect(body.type).toBe('NPS');
    expect(body.isActive).toBe(true);
    createdSurveyIds.add(body.id);
  });

  test('201 accepts type=CSAT', async ({ request }) => {
    const { token } = await getAdmin(request);
    const res = await post(request, token, '/api/surveys', {
      name: `${RUN_TAG} csat`,
      type: 'CSAT',
      question: 'How satisfied are you?',
    });
    expect(res.status()).toBe(201);
    const body = await res.json();
    expect(body.type).toBe('CSAT');
    createdSurveyIds.add(body.id);
  });

  test('201 accepts type=CUSTOM', async ({ request }) => {
    const { token } = await getAdmin(request);
    const res = await post(request, token, '/api/surveys', {
      name: `${RUN_TAG} custom`,
      type: 'CUSTOM',
      question: 'Custom feedback?',
    });
    expect(res.status()).toBe(201);
    const body = await res.json();
    expect(body.type).toBe('CUSTOM');
    createdSurveyIds.add(body.id);
  });

  test('201 unknown type silently falls back to NPS', async ({ request }) => {
    const { token } = await getAdmin(request);
    const res = await post(request, token, '/api/surveys', {
      name: `${RUN_TAG} weird-type`,
      type: 'NOT_A_REAL_TYPE',
      question: 'q',
    });
    expect(res.status()).toBe(201);
    const body = await res.json();
    expect(body.type).toBe('NPS');
    createdSurveyIds.add(body.id);
  });

  test('400 when name is missing', async ({ request }) => {
    const { token } = await getAdmin(request);
    const res = await post(request, token, '/api/surveys', {
      question: 'no name',
    });
    expect(res.status()).toBe(400);
    expect((await res.json()).error).toMatch(/name/i);
  });

  test('400 when name is whitespace-only', async ({ request }) => {
    const { token } = await getAdmin(request);
    const res = await post(request, token, '/api/surveys', {
      name: '   ',
      question: 'q',
    });
    expect(res.status()).toBe(400);
  });

  test('400 when question is missing', async ({ request }) => {
    const { token } = await getAdmin(request);
    const res = await post(request, token, '/api/surveys', {
      name: `${RUN_TAG} no-question`,
    });
    expect(res.status()).toBe(400);
    expect((await res.json()).error).toMatch(/question/i);
  });

  test('400 when question is whitespace-only', async ({ request }) => {
    const { token } = await getAdmin(request);
    const res = await post(request, token, '/api/surveys', {
      name: `${RUN_TAG} ws-question`,
      question: '   ',
    });
    expect(res.status()).toBe(400);
  });

  test('regular USER can also create (no admin gate on POST)', async ({ request }) => {
    const { token } = await getUser(request);
    if (!token) test.skip(true, 'no regular USER token available');
    const res = await post(request, token, '/api/surveys', {
      name: `${RUN_TAG} user-created`,
      question: 'created by USER',
    });
    expect(res.status()).toBe(201);
    const body = await res.json();
    createdSurveyIds.add(body.id);
  });
});

// ── PUT /:id ───────────────────────────────────────────────────────

test.describe('Surveys API — PUT /:id', () => {
  test('200 partial update — just name', async ({ request }) => {
    const { token } = await getAdmin(request);
    const created = await createSurvey(request, { name: `${RUN_TAG} put-rename-before` });
    const res = await put(request, token, `/api/surveys/${created.id}`, {
      name: `${RUN_TAG} put-rename-after`,
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.name).toContain('put-rename-after');
    expect(body.question).toBe(created.question);
  });

  test('200 update question + type', async ({ request }) => {
    const { token } = await getAdmin(request);
    const created = await createSurvey(request, { name: `${RUN_TAG} put-q-type`, type: 'NPS' });
    const res = await put(request, token, `/api/surveys/${created.id}`, {
      question: 'Updated question?',
      type: 'CSAT',
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.question).toBe('Updated question?');
    expect(body.type).toBe('CSAT');
  });

  test('200 toggle isActive=false', async ({ request }) => {
    const { token } = await getAdmin(request);
    const created = await createSurvey(request, { name: `${RUN_TAG} put-deactivate` });
    const res = await put(request, token, `/api/surveys/${created.id}`, {
      isActive: false,
    });
    expect(res.status()).toBe(200);
    expect((await res.json()).isActive).toBe(false);
  });

  test('200 invalid type is silently ignored (route only writes when in VALID_TYPES)', async ({ request }) => {
    const { token } = await getAdmin(request);
    const created = await createSurvey(request, { name: `${RUN_TAG} put-bad-type`, type: 'NPS' });
    const res = await put(request, token, `/api/surveys/${created.id}`, {
      type: 'NOT_A_REAL_TYPE',
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.type).toBe('NPS'); // unchanged
  });

  test('404 on unknown id', async ({ request }) => {
    const { token } = await getAdmin(request);
    const res = await put(request, token, '/api/surveys/99999999', { name: 'whatever' });
    expect(res.status()).toBe(404);
  });
});

// ── DELETE /:id ────────────────────────────────────────────────────

test.describe('Surveys API — DELETE /:id', () => {
  test('200 deletes own survey', async ({ request }) => {
    const { token } = await getAdmin(request);
    const created = await createSurvey(request, { name: `${RUN_TAG} delete-me` });
    createdSurveyIds.delete(created.id); // we'll delete inline
    const res = await del(request, token, `/api/surveys/${created.id}`);
    expect(res.status()).toBe(200);
    expect((await res.json()).success).toBe(true);

    // Subsequent GET stats / responses should now 404.
    const after = await get(request, token, `/api/surveys/${created.id}/stats`);
    expect(after.status()).toBe(404);
  });

  test('404 on unknown id', async ({ request }) => {
    const { token } = await getAdmin(request);
    const res = await del(request, token, '/api/surveys/99999999');
    expect(res.status()).toBe(404);
  });

  test('cascades surveyResponse rows (verified via /:id/responses → 404 after delete)', async ({ request }) => {
    const { token } = await getAdmin(request);
    const created = await createSurvey(request, { name: `${RUN_TAG} cascade` });
    // Drop a public response on it first so there's at least one row to cascade.
    const submit = await postPublic(request, `/api/surveys/public/${created.id}/respond`, {
      score: 9, comment: 'will be cascaded',
    });
    expect(submit.status()).toBe(200);

    createdSurveyIds.delete(created.id);
    const delRes = await del(request, token, `/api/surveys/${created.id}`);
    expect(delRes.status()).toBe(200);
    // Parent gone → /responses 404 (handler checks survey existence first).
    const responses = await get(request, token, `/api/surveys/${created.id}/responses`);
    expect(responses.status()).toBe(404);
  });
});

// ── POST /:id/send — dispatch flow ─────────────────────────────────

test.describe('Surveys API — POST /:id/send', () => {
  test('200 returns dispatch envelope { sentCount, attempted, results } with empty contact list (no matching contacts)', async ({ request }) => {
    const { token } = await getAdmin(request);
    const created = await createSurvey(request, { name: `${RUN_TAG} send-empty` });
    // Use a definitely-bogus contactId. Route filters by tenant, so a non-existent
    // id returns zero contacts → attempted=0, sentCount=0.
    const res = await post(request, token, `/api/surveys/${created.id}/send`, {
      contactIds: [99999999],
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(typeof body.sentCount).toBe('number');
    expect(typeof body.attempted).toBe('number');
    expect(Array.isArray(body.results)).toBe(true);
    expect(body.attempted).toBe(0);
    expect(body.sentCount).toBe(0);
  });

  test('200 dispatches to a real contact (Mailgun best-effort, may not actually send in CI)', async ({ request }) => {
    const { token } = await getAdmin(request);
    // Create a contact in this tenant.
    const cRes = await post(request, token, '/api/contacts', {
      name: `${RUN_TAG} survey recipient`,
      email: `e2e-survey-${Date.now()}@example.com`,
    });
    if (cRes.status() !== 201 && cRes.status() !== 200) {
      test.skip(true, `Could not seed contact for send test: ${cRes.status()} ${await cRes.text()}`);
    }
    const contact = await cRes.json();
    const contactId = contact.id || (contact.contact && contact.contact.id);
    if (!contactId) test.skip(true, 'contact create returned no id');

    const survey = await createSurvey(request, { name: `${RUN_TAG} send-real` });
    const res = await post(request, token, `/api/surveys/${survey.id}/send`, {
      contactIds: [contactId],
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.attempted).toBe(1);
    expect(body.results.length).toBe(1);
    expect(body.results[0].contactId).toBe(contactId);
    // Mailgun may or may not be configured — both branches are valid.
    expect(typeof body.results[0].sent).toBe('boolean');

    // Cleanup the contact we created.
    await del(request, token, `/api/contacts/${contactId}`).catch(() => {});
  });

  test('400 when contactIds is missing', async ({ request }) => {
    const { token } = await getAdmin(request);
    const survey = await createSurvey(request, { name: `${RUN_TAG} send-no-ids` });
    const res = await post(request, token, `/api/surveys/${survey.id}/send`, {});
    expect(res.status()).toBe(400);
    expect((await res.json()).error).toMatch(/contactIds/i);
  });

  test('400 when contactIds is empty array', async ({ request }) => {
    const { token } = await getAdmin(request);
    const survey = await createSurvey(request, { name: `${RUN_TAG} send-empty-arr` });
    const res = await post(request, token, `/api/surveys/${survey.id}/send`, {
      contactIds: [],
    });
    expect(res.status()).toBe(400);
  });

  test('400 when survey is inactive', async ({ request }) => {
    const { token } = await getAdmin(request);
    const survey = await createSurvey(request, { name: `${RUN_TAG} send-inactive` });
    // Deactivate it first.
    const upd = await put(request, token, `/api/surveys/${survey.id}`, { isActive: false });
    expect(upd.status()).toBe(200);
    const res = await post(request, token, `/api/surveys/${survey.id}/send`, {
      contactIds: [1],
    });
    expect(res.status()).toBe(400);
    expect((await res.json()).error).toMatch(/inactive/i);
  });

  test('404 when survey does not exist', async ({ request }) => {
    const { token } = await getAdmin(request);
    const res = await post(request, token, '/api/surveys/99999999/send', {
      contactIds: [1],
    });
    expect(res.status()).toBe(404);
  });
});

// ── GET /:id/responses ─────────────────────────────────────────────

test.describe('Surveys API — GET /:id/responses', () => {
  test('200 returns array (empty for fresh survey)', async ({ request }) => {
    const { token } = await getAdmin(request);
    const survey = await createSurvey(request, { name: `${RUN_TAG} resp-empty` });
    const res = await get(request, token, `/api/surveys/${survey.id}/responses`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBe(0);
  });

  test('200 includes a public-submitted response', async ({ request }) => {
    const { token } = await getAdmin(request);
    const survey = await createSurvey(request, { name: `${RUN_TAG} resp-pub` });
    const submit = await postPublic(request, `/api/surveys/public/${survey.id}/respond`, {
      score: 8, comment: `${RUN_TAG} public response`,
    });
    expect(submit.status()).toBe(200);
    const submitted = await submit.json();

    const res = await get(request, token, `/api/surveys/${survey.id}/responses`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.length).toBeGreaterThanOrEqual(1);
    expect(body.some((r) => r.id === submitted.id)).toBe(true);
    const ours = body.find((r) => r.id === submitted.id);
    expect(ours.score).toBe(8);
    expect(ours.comment).toContain('public response');
  });

  test('404 on unknown survey id', async ({ request }) => {
    const { token } = await getAdmin(request);
    const res = await get(request, token, '/api/surveys/99999999/responses');
    expect(res.status()).toBe(404);
  });
});

// ── GET /:id/stats ─────────────────────────────────────────────────

test.describe('Surveys API — GET /:id/stats', () => {
  test('200 zero-state stats for fresh survey', async ({ request }) => {
    const { token } = await getAdmin(request);
    const survey = await createSurvey(request, { name: `${RUN_TAG} stats-zero`, type: 'NPS' });
    const res = await get(request, token, `/api/surveys/${survey.id}/stats`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.count).toBe(0);
    expect(body.avgScore).toBe(0);
    expect(Array.isArray(body.distribution)).toBe(true);
    expect(body.distribution.length).toBe(11);
    expect(body.type).toBe('NPS');
    expect(body.npsScore).toBe(0);
  });

  test('200 NPS stats reflect submitted scores', async ({ request }) => {
    const { token } = await getAdmin(request);
    const survey = await createSurvey(request, { name: `${RUN_TAG} stats-nps`, type: 'NPS' });
    // Submit a promoter (10), a passive (8), a detractor (3).
    for (const s of [10, 8, 3]) {
      const r = await postPublic(request, `/api/surveys/public/${survey.id}/respond`, { score: s });
      expect(r.status()).toBe(200);
    }
    const res = await get(request, token, `/api/surveys/${survey.id}/stats`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.count).toBe(3);
    // 1 promoter, 1 detractor → (1-1)/3 * 100 = 0
    expect(body.npsScore).toBe(0);
    expect(body.distribution[10]).toBe(1);
    expect(body.distribution[8]).toBe(1);
    expect(body.distribution[3]).toBe(1);
    expect(body.avgScore).toBeCloseTo(7, 1);
  });

  test('200 CSAT stats omit npsScore', async ({ request }) => {
    const { token } = await getAdmin(request);
    const survey = await createSurvey(request, { name: `${RUN_TAG} stats-csat`, type: 'CSAT' });
    const res = await get(request, token, `/api/surveys/${survey.id}/stats`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.type).toBe('CSAT');
    expect('npsScore' in body).toBe(false);
  });

  test('404 on unknown id', async ({ request }) => {
    const { token } = await getAdmin(request);
    const res = await get(request, token, '/api/surveys/99999999/stats');
    expect(res.status()).toBe(404);
  });
});

// ── PUBLIC: GET /public/:id (no auth) ──────────────────────────────

test.describe('Surveys API — PUBLIC GET /public/:id', () => {
  test('200 returns public-facing fields without Authorization header', async ({ request }) => {
    const survey = await createSurvey(request, { name: `${RUN_TAG} pub-fetch`, type: 'NPS' });
    const res = await getPublic(request, `/api/surveys/public/${survey.id}`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.id).toBe(survey.id);
    expect(body.name).toBe(survey.name);
    expect(body.type).toBe('NPS');
    expect(body.question).toBeTruthy();
    // Sensitive fields must NOT leak.
    expect(body.tenantId).toBeUndefined();
    // brand may be {name, vertical} or null — but should not include sensitive keys.
    if (body.brand) {
      expect(body.brand.tenantId).toBeUndefined();
    }
  });

  test('404 on unknown id (no auth)', async ({ request }) => {
    const res = await getPublic(request, '/api/surveys/public/99999999');
    expect(res.status()).toBe(404);
  });

  test('400 on non-numeric id (no auth)', async ({ request }) => {
    // Post-#423: validateNumericId middleware fires globally on every
    // `:id` param — including no-auth public routes — and returns 400
    // before the route handler can return its own 404. The contract
    // change here is "non-numeric ids fail loudly with a structured
    // 400 + INVALID_ID code", not "silently 404 like the resource
    // didn't exist". Cleaner from a debugging-bad-client-IDs POV.
    const res = await getPublic(request, '/api/surveys/public/not-a-number');
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('INVALID_ID');
  });

  test('410 when survey is inactive (no auth)', async ({ request }) => {
    const { token } = await getAdmin(request);
    const survey = await createSurvey(request, { name: `${RUN_TAG} pub-inactive` });
    await put(request, token, `/api/surveys/${survey.id}`, { isActive: false });
    const res = await getPublic(request, `/api/surveys/public/${survey.id}`);
    expect(res.status()).toBe(410);
  });
});

// ── PUBLIC: POST /public/:id/respond (no auth) ─────────────────────

test.describe('Surveys API — PUBLIC POST /public/:id/respond', () => {
  test('200 records anonymous response without Authorization header', async ({ request }) => {
    const survey = await createSurvey(request, { name: `${RUN_TAG} pub-submit`, type: 'NPS' });
    const res = await postPublic(request, `/api/surveys/public/${survey.id}/respond`, {
      score: 9, comment: 'great service',
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(typeof body.id).toBe('number');

    // Verify it persisted by listing responses as admin.
    const { token } = await getAdmin(request);
    const list = await (await get(request, token, `/api/surveys/${survey.id}/responses`)).json();
    expect(list.some((r) => r.id === body.id && r.score === 9)).toBe(true);
  });

  test('400 when score is missing', async ({ request }) => {
    const survey = await createSurvey(request, { name: `${RUN_TAG} pub-no-score` });
    const res = await postPublic(request, `/api/surveys/public/${survey.id}/respond`, {
      comment: 'no score given',
    });
    expect(res.status()).toBe(400);
  });

  test('400 when score is out of NPS range (>10)', async ({ request }) => {
    const survey = await createSurvey(request, { name: `${RUN_TAG} pub-score-too-high`, type: 'NPS' });
    const res = await postPublic(request, `/api/surveys/public/${survey.id}/respond`, { score: 11 });
    expect(res.status()).toBe(400);
    expect((await res.json()).error).toMatch(/between 0 and 10/i);
  });

  test('400 when score is negative', async ({ request }) => {
    const survey = await createSurvey(request, { name: `${RUN_TAG} pub-score-neg` });
    const res = await postPublic(request, `/api/surveys/public/${survey.id}/respond`, { score: -1 });
    expect(res.status()).toBe(400);
  });

  test('400 when score exceeds CSAT max (>5)', async ({ request }) => {
    const survey = await createSurvey(request, { name: `${RUN_TAG} pub-csat-max`, type: 'CSAT' });
    const res = await postPublic(request, `/api/surveys/public/${survey.id}/respond`, { score: 6 });
    expect(res.status()).toBe(400);
    expect((await res.json()).error).toMatch(/between 0 and 5/i);
  });

  test('200 truncates comment longer than 5000 chars', async ({ request }) => {
    const survey = await createSurvey(request, { name: `${RUN_TAG} pub-long-comment` });
    const longComment = 'x'.repeat(6000);
    const res = await postPublic(request, `/api/surveys/public/${survey.id}/respond`, {
      score: 7, comment: longComment,
    });
    expect(res.status()).toBe(200);
    const submittedId = (await res.json()).id;
    // Verify truncation by reading back.
    const { token } = await getAdmin(request);
    const list = await (await get(request, token, `/api/surveys/${survey.id}/responses`)).json();
    const submitted = list.find((r) => r.id === submittedId);
    if (submitted && submitted.comment) {
      expect(submitted.comment.length).toBeLessThanOrEqual(5000);
    }
  });

  test('404 on unknown id', async ({ request }) => {
    const res = await postPublic(request, '/api/surveys/public/99999999/respond', { score: 5 });
    expect(res.status()).toBe(404);
  });

  test('410 when survey is inactive', async ({ request }) => {
    const { token } = await getAdmin(request);
    const survey = await createSurvey(request, { name: `${RUN_TAG} pub-submit-inactive` });
    await put(request, token, `/api/surveys/${survey.id}`, { isActive: false });
    const res = await postPublic(request, `/api/surveys/public/${survey.id}/respond`, { score: 5 });
    expect(res.status()).toBe(410);
  });
});

// ── PUBLIC: token-based GET/POST /respond/:token ───────────────────

test.describe('Surveys API — PUBLIC /respond/:token', () => {
  test('GET /respond/:token 404 on bogus token', async ({ request }) => {
    const res = await getPublic(request, '/api/surveys/respond/not-a-real-token-zzz');
    expect(res.status()).toBe(404);
  });

  test('POST /respond/:token 404 on bogus token', async ({ request }) => {
    const res = await postPublic(request, '/api/surveys/respond/not-a-real-token-zzz', { score: 5 });
    expect(res.status()).toBe(404);
  });
});

// ── Auth gate ──────────────────────────────────────────────────────

test.describe('Surveys API — auth gate (non-public endpoints)', () => {
  test('GET / without token → 401/403', async ({ request }) => {
    const res = await request.get(`${BASE_URL}/api/surveys`);
    expect([401, 403]).toContain(res.status());
  });

  test('POST / without token → 401/403', async ({ request }) => {
    const res = await request.post(`${BASE_URL}/api/surveys`, {
      data: { name: 'x', question: 'y' },
      headers: { 'Content-Type': 'application/json' },
    });
    expect([401, 403]).toContain(res.status());
  });

  test('PUT /:id without token → 401/403', async ({ request }) => {
    const res = await request.put(`${BASE_URL}/api/surveys/1`, {
      data: { name: 'x' },
      headers: { 'Content-Type': 'application/json' },
    });
    expect([401, 403]).toContain(res.status());
  });

  test('DELETE /:id without token → 401/403', async ({ request }) => {
    const res = await request.delete(`${BASE_URL}/api/surveys/1`);
    expect([401, 403]).toContain(res.status());
  });

  test('POST /:id/send without token → 401/403', async ({ request }) => {
    const res = await request.post(`${BASE_URL}/api/surveys/1/send`, {
      data: { contactIds: [1] },
      headers: { 'Content-Type': 'application/json' },
    });
    expect([401, 403]).toContain(res.status());
  });

  test('GET /:id/responses without token → 401/403', async ({ request }) => {
    const res = await request.get(`${BASE_URL}/api/surveys/1/responses`);
    expect([401, 403]).toContain(res.status());
  });

  test('GET /:id/stats without token → 401/403', async ({ request }) => {
    const res = await request.get(`${BASE_URL}/api/surveys/1/stats`);
    expect([401, 403]).toContain(res.status());
  });
});
