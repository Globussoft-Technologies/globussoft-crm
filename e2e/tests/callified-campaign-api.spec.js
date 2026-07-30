// @ts-check
/**
 * Callified campaign surface — E2E API coverage.
 *
 * Pins the new routes added for the leads-page campaign column + bulk dial:
 *   - PUT  /api/contacts/:id              (callifiedCampaignId assignment)
 *   - GET  /api/callified/campaigns/with-lead-counts
 *   - POST /api/callified/campaigns/:campaignId/dial-all
 *   - GET  /api/callified/leads/call-summary?contactIds=...
 *
 * Strategy: this spec does NOT depend on a live Callified.ai account. The
 * contact-assignment endpoint and the call-summary endpoint are exercised with
 * real DB state; the campaign-list and dial-all endpoints are asserted at the
 * route-contract level (auth, role gate, and structured error shape) because
 * they reach out to Callified and will return CALLIFIED_NOT_CONFIGURED in CI.
 *
 * All created contacts are tagged with RUN_TAG and deleted in afterAll.
 */
const { test, expect } = require('@playwright/test');

test.describe.configure({ mode: 'serial' });

const BASE_URL = process.env.BASE_URL || 'https://crm.globusdemos.com';
const REQUEST_TIMEOUT = 60000;
const RUN_TAG = `E2E_CALLIFIED_${Date.now()}`;

let adminToken = null;
let adminUserId = null;
let userToken = null;

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
  }
  return { token: userToken };
}

const headers = (token) => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' });

async function retryOn5xx(fn) {
  let r;
  for (let attempt = 0; attempt < 3; attempt++) {
    r = await fn();
    if (r.status() < 500) return r;
    await new Promise((res) => setTimeout(res, 1000 * (attempt + 1)));
  }
  return r;
}

async function get(request, token, path) {
  return retryOn5xx(() => request.get(`${BASE_URL}${path}`, { headers: headers(token), timeout: REQUEST_TIMEOUT }));
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

const createdContactIds = [];

test.afterAll(async ({ request }) => {
  const { token } = await getAdmin(request);
  if (!token) return;
  const deadline = Date.now() + 40_000;
  for (const id of createdContactIds) {
    if (Date.now() > deadline) break;
    await del(request, token, `/api/contacts/${id}`).catch(() => { });
  }
});

async function createTaggedLead(request, overrides = {}) {
  const { token } = await getAdmin(request);
  const unique = `${RUN_TAG}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const res = await post(request, token, '/api/contacts', {
    name: overrides.name || `Callified Test ${unique}`,
    email: overrides.email || `callified_${unique}@example.com`,
    status: 'Lead',
    source: 'Organic',
    ...overrides,
  });
  expect(res.status(), `create lead: ${await res.text()}`).toBe(201);
  const body = await res.json();
  createdContactIds.push(body.id);
  return body;
}

test.describe('PUT /api/contacts/:id — callifiedCampaignId assignment', () => {
  test('admin can assign a Callified campaign to a lead and read it back', async ({ request }) => {
    const { token } = await getAdmin(request);
    const lead = await createTaggedLead(request);

    const putRes = await put(request, token, `/api/contacts/${lead.id}`, {
      callifiedCampaignId: 42,
    });
    expect(putRes.status(), `assign campaign: ${await putRes.text()}`).toBe(200);
    const updated = await putRes.json();
    expect(updated.callifiedCampaignId).toBe(42);

    const getRes = await get(request, token, `/api/contacts/${lead.id}`);
    expect(getRes.status()).toBe(200);
    const fetched = await getRes.json();
    expect(fetched.callifiedCampaignId).toBe(42);
  });

  test('empty string callifiedCampaignId is normalized to null', async ({ request }) => {
    const { token } = await getAdmin(request);
    const lead = await createTaggedLead(request, { callifiedCampaignId: 42 });

    const putRes = await put(request, token, `/api/contacts/${lead.id}`, {
      callifiedCampaignId: '',
    });
    expect(putRes.status(), `clear campaign: ${await putRes.text()}`).toBe(200);
    const updated = await putRes.json();
    expect(updated.callifiedCampaignId).toBeNull();
  });

  test('regular USER can update a lead campaign (route contract)', async ({ request }) => {
    const { token: adminTok } = await getAdmin(request);
    const { token: userTok } = await getUser(request);
    const lead = await createTaggedLead(request);

    // Note: PUT /api/contacts/:id currently has no role/ownership gate, so a
    // USER token can update any contact in its tenant. This test pins that
    // contract rather than the desired RBAC boundary.
    const putRes = await put(request, userTok, `/api/contacts/${lead.id}`, {
      callifiedCampaignId: 99,
    });
    expect(putRes.status()).toBe(200);

    const getRes = await get(request, adminTok, `/api/contacts/${lead.id}`);
    expect((await getRes.json()).callifiedCampaignId).toBe(99);
  });
});

test.describe('GET /api/callified/campaigns/with-lead-counts', () => {
  test('admin receives structured response (campaigns array)', async ({ request }) => {
    const { token } = await getAdmin(request);
    const res = await get(request, token, '/api/callified/campaigns/with-lead-counts');
    // 200 if Callified is configured; 503 with structured code if not.
    expect([200, 503]).toContain(res.status());
    const body = await res.json();
    if (res.status() === 200) {
      expect(Array.isArray(body.campaigns)).toBe(true);
    } else {
      expect(body.code).toMatch(/CALLIFIED_(NOT_CONFIGURED|AUTH_FAILED)/);
    }
  });

  test('regular USER is forbidden', async ({ request }) => {
    const { token } = await getUser(request);
    const res = await get(request, token, '/api/callified/campaigns/with-lead-counts');
    expect(res.status()).toBe(403);
  });
});

test.describe('POST /api/callified/campaigns/:campaignId/dial-all', () => {
  test('admin dials a campaign with no assigned leads → empty batch result', async ({ request }) => {
    const { token } = await getAdmin(request);
    const fakeCampaignId = 999999;
    const res = await post(request, token, `/api/callified/campaigns/${fakeCampaignId}/dial-all`, {});
    expect([200, 503]).toContain(res.status());
    const body = await res.json();
    if (res.status() === 200) {
      expect(body).toMatchObject({ total: 0, succeeded: 0, failed: 0, results: [] });
    } else {
      expect(body.code).toMatch(/CALLIFIED_(NOT_CONFIGURED|AUTH_FAILED)/);
    }
  });

  test('invalid campaignId → 400', async ({ request }) => {
    const { token } = await getAdmin(request);
    const res = await post(request, token, '/api/callified/campaigns/0/dial-all', {});
    expect(res.status()).toBe(400);
    expect((await res.json()).code).toBe('INVALID_CAMPAIGN_ID');
  });

  test('regular USER is forbidden', async ({ request }) => {
    const { token } = await getUser(request);
    const res = await post(request, token, '/api/callified/campaigns/1/dial-all', {});
    expect(res.status()).toBe(403);
  });
});

test.describe('GET /api/callified/leads/call-summary', () => {
  test('returns empty summaries for unknown contact ids', async ({ request }) => {
    const { token } = await getAdmin(request);
    const res = await get(request, token, '/api/callified/leads/call-summary?contactIds=999999,999998');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      summaries: {
        999999: { callCount: 0, lastCallifiedLeadId: null, lastScore: null },
        999998: { callCount: 0, lastCallifiedLeadId: null, lastScore: null },
      },
    });
  });

  test('empty contactIds → { summaries: {} }', async ({ request }) => {
    const { token } = await getAdmin(request);
    const res = await get(request, token, '/api/callified/leads/call-summary');
    expect(res.status()).toBe(200);
    expect(await res.json()).toEqual({ summaries: {} });
  });

  test('non-numeric ids are ignored', async ({ request }) => {
    const { token } = await getAdmin(request);
    const res = await get(request, token, '/api/callified/leads/call-summary?contactIds=abc,0,-1');
    expect(res.status()).toBe(200);
    expect(await res.json()).toEqual({ summaries: {} });
  });
});
