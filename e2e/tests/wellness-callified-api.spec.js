// @ts-check
/**
 * Wellness ↔ Callified calling surface — E2E API coverage.
 *
 * Pins the routes behind the Appointments page "Call" action
 * (backend/routes/wellness_callified.js):
 *   - GET  /api/wellness/callified/status
 *   - GET  /api/wellness/callified/campaigns
 *   - GET  /api/wellness/callified/visits/:visitId/context
 *   - POST /api/wellness/callified/visits/:visitId/ai-call
 *   - POST /api/wellness/callified/visits/:visitId/manual-call
 *
 * Strategy: this spec does NOT depend on a live Callified.ai account. CI has
 * no Callified credentials, so anything that reaches the vendor answers
 * CALLIFIED_NOT_CONFIGURED. What IS asserted end-to-end is everything the CRM
 * owns and can get wrong on its own:
 *
 *   - auth is required, and a generic-tenant admin is refused (wellness gate)
 *   - a visit from another tenant 404s rather than leaking a patient
 *   - campaignId is validated BEFORE any vendor call is attempted
 *   - the failure envelope is the canonical {error, code} shape with a
 *     retryable status, never a naked 500
 *
 * The last one is the point: an unconfigured tenant must produce an
 * actionable "set up Callified" message, not a stack trace.
 */
const { test, expect } = require('@playwright/test');

const BASE_URL = process.env.BASE_URL || 'https://crm.globusdemos.com';
const REQUEST_TIMEOUT = 60000;

const FIXTURES = {
  wellnessAdmin: { email: 'admin@wellness.demo', password: 'password123' },
  genericAdmin: { email: 'admin@globussoft.com', password: 'password123' },
};

const tokenCache = {};

async function login(request, who) {
  if (who in tokenCache) return tokenCache[who];
  const r = await request.post(`${BASE_URL}/api/auth/login`, {
    data: FIXTURES[who],
    headers: { 'Content-Type': 'application/json' },
    timeout: REQUEST_TIMEOUT,
  });
  tokenCache[who] = r.ok() ? (await r.json()).token : null;
  return tokenCache[who];
}

const headers = (token) => ({
  Authorization: `Bearer ${token}`,
  'Content-Type': 'application/json',
});

async function firstVisitId(request, token) {
  const r = await request.get(`${BASE_URL}/api/wellness/visits?limit=1`, {
    headers: headers(token),
    timeout: REQUEST_TIMEOUT,
  });
  if (!r.ok()) return null;
  const body = await r.json();
  const rows = Array.isArray(body) ? body : body.visits || [];
  return rows.length ? rows[0].id : null;
}

// Every vendor-dependent failure must still be a shaped, actionable error.
const ACCEPTABLE_CALL_STATUSES = [
  200, // a configured tenant actually placed the call
  400, // no valid phone on the patient
  402, // monthly AI-calling cap reached
  403, // calling disabled for this tenant
  429, // redial cooldown
  502, // Callified answered with something unusable
  503, // Callified not configured / auth failed
];

test.describe('wellness Callified calling — auth + tenant gates', () => {
  for (const path of [
    '/api/wellness/callified/status',
    '/api/wellness/callified/campaigns',
    '/api/wellness/callified/visits/1/context',
  ]) {
    test(`GET ${path} requires authentication`, async ({ request }) => {
      const r = await request.get(`${BASE_URL}${path}`, { timeout: REQUEST_TIMEOUT });
      expect([401, 403]).toContain(r.status());
    });
  }

  test('POST ai-call requires authentication', async ({ request }) => {
    const r = await request.post(`${BASE_URL}/api/wellness/callified/visits/1/ai-call`, {
      data: { campaignId: 1 },
      headers: { 'Content-Type': 'application/json' },
      timeout: REQUEST_TIMEOUT,
    });
    expect([401, 403]).toContain(r.status());
  });

  test('POST manual-call requires authentication', async ({ request }) => {
    const r = await request.post(`${BASE_URL}/api/wellness/callified/visits/1/manual-call`, {
      data: { campaignId: 1 },
      headers: { 'Content-Type': 'application/json' },
      timeout: REQUEST_TIMEOUT,
    });
    expect([401, 403]).toContain(r.status());
  });

  test('a generic-tenant admin is refused — this is a wellness surface', async ({ request }) => {
    const token = await login(request, 'genericAdmin');
    test.skip(!token, 'generic admin login failed');
    const r = await request.get(`${BASE_URL}/api/wellness/callified/status`, {
      headers: headers(token),
      timeout: REQUEST_TIMEOUT,
    });
    expect(r.status()).toBe(403);
    const body = await r.json();
    expect(body.code).toBeTruthy();
  });
});

test.describe('GET /api/wellness/callified/status', () => {
  test('answers with the two booleans the Appointments page gates on', async ({ request }) => {
    const token = await login(request, 'wellnessAdmin');
    test.skip(!token, 'wellness admin login failed');
    const r = await request.get(`${BASE_URL}/api/wellness/callified/status`, {
      headers: headers(token),
      timeout: REQUEST_TIMEOUT,
    });
    // Never errors — an unconfigured tenant is a normal state, and the page
    // needs a definite answer to decide whether to render the Call action.
    expect(r.ok()).toBeTruthy();
    const body = await r.json();
    expect(typeof body.configured).toBe('boolean');
    expect(typeof body.enabled).toBe('boolean');
  });
});

test.describe('GET /api/wellness/callified/campaigns', () => {
  test('returns a campaign list or a shaped not-configured error', async ({ request }) => {
    const token = await login(request, 'wellnessAdmin');
    test.skip(!token, 'wellness admin login failed');
    const r = await request.get(`${BASE_URL}/api/wellness/callified/campaigns`, {
      headers: headers(token),
      timeout: REQUEST_TIMEOUT,
    });
    expect([200, 502, 503]).toContain(r.status());
    const body = await r.json();
    if (r.ok()) {
      expect(Array.isArray(body.campaigns)).toBe(true);
    } else {
      expect(body.error).toBeTruthy();
      expect(body.code).toBeTruthy();
    }
  });
});

test.describe('GET /api/wellness/callified/visits/:visitId/context', () => {
  test('describes who would be called and whether the number is dialable', async ({ request }) => {
    const token = await login(request, 'wellnessAdmin');
    test.skip(!token, 'wellness admin login failed');
    const visitId = await firstVisitId(request, token);
    test.skip(!visitId, 'no visits seeded for the wellness tenant');

    const r = await request.get(
      `${BASE_URL}/api/wellness/callified/visits/${visitId}/context`,
      { headers: headers(token), timeout: REQUEST_TIMEOUT },
    );
    expect([200, 400]).toContain(r.status());
    if (!r.ok()) return; // visit with no patient on file

    const body = await r.json();
    expect(body.visitId).toBe(visitId);
    expect(typeof body.phoneValid).toBe('boolean');
    expect(body).toHaveProperty('patientName');
    // contactId is null until the first call links a CRM Contact — the
    // read-only context endpoint must NOT create one as a side effect.
    expect(body).toHaveProperty('contactId');
  });

  test('a nonexistent visit 404s instead of leaking another tenant', async ({ request }) => {
    const token = await login(request, 'wellnessAdmin');
    test.skip(!token, 'wellness admin login failed');
    const r = await request.get(
      `${BASE_URL}/api/wellness/callified/visits/999999999/context`,
      { headers: headers(token), timeout: REQUEST_TIMEOUT },
    );
    expect(r.status()).toBe(404);
    expect((await r.json()).code).toBe('VISIT_NOT_FOUND');
  });
});

test.describe('call placement contract', () => {
  for (const mode of ['ai-call', 'manual-call']) {
    test(`POST ${mode} rejects a missing campaignId before calling the vendor`, async ({ request }) => {
      const token = await login(request, 'wellnessAdmin');
      test.skip(!token, 'wellness admin login failed');
      const r = await request.post(
        `${BASE_URL}/api/wellness/callified/visits/1/${mode}`,
        { data: {}, headers: headers(token), timeout: REQUEST_TIMEOUT },
      );
      expect(r.status()).toBe(400);
      expect((await r.json()).code).toBe('MISSING_CAMPAIGN_ID');
    });

    test(`POST ${mode} 404s an unknown visit`, async ({ request }) => {
      const token = await login(request, 'wellnessAdmin');
      test.skip(!token, 'wellness admin login failed');
      const r = await request.post(
        `${BASE_URL}/api/wellness/callified/visits/999999999/${mode}`,
        { data: { campaignId: 1 }, headers: headers(token), timeout: REQUEST_TIMEOUT },
      );
      expect(r.status()).toBe(404);
      expect((await r.json()).code).toBe('VISIT_NOT_FOUND');
    });

    test(`POST ${mode} fails with a shaped, actionable error when Callified is unavailable`, async ({ request }) => {
      const token = await login(request, 'wellnessAdmin');
      test.skip(!token, 'wellness admin login failed');
      const visitId = await firstVisitId(request, token);
      test.skip(!visitId, 'no visits seeded for the wellness tenant');

      const r = await request.post(
        `${BASE_URL}/api/wellness/callified/visits/${visitId}/${mode}`,
        { data: { campaignId: 1 }, headers: headers(token), timeout: REQUEST_TIMEOUT },
      );
      expect(ACCEPTABLE_CALL_STATUSES).toContain(r.status());
      const body = await r.json();
      if (r.ok()) {
        expect(body.callifiedLeadId).toBeTruthy();
        if (mode === 'manual-call') {
          // The browser must get a relay ticket, never Callified's own socket.
          expect(body.bridgeTicket).toBeTruthy();
          expect(body.bridgePath).toBe('/ws/callified-agent');
        }
      } else {
        expect(body.error).toBeTruthy();
        expect(body.code).toBeTruthy();
      }
    });
  }
});

test.describe('agent bridge relay', () => {
  test('the relay path refuses a plain HTTP GET (it is a WebSocket upgrade)', async ({ request }) => {
    // A ticketless / non-upgrade request must not be answered with the SPA
    // shell or a 200 — the relay only exists for redeemed upgrade handshakes.
    const r = await request
      .get(`${BASE_URL}/ws/callified-agent?ticket=definitely-not-a-real-ticket`, {
        timeout: REQUEST_TIMEOUT,
        failOnStatusCode: false,
      })
      .catch(() => null);
    // A destroyed socket surfaces as a null response; otherwise it must be a
    // 4xx/5xx, never a successful body.
    if (r) expect(r.status()).toBeGreaterThanOrEqual(400);
  });
});
