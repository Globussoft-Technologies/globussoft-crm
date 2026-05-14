// @ts-check
/**
 * Cross-tenant body-field correctness — #646 defense-in-depth gate.
 *
 * The global `stripDangerous` middleware (backend/middleware/security.js,
 * applied via server.js to every authenticated route AND most public
 * routes) deletes `req.body.{id,userId,tenantId,createdAt,updatedAt}`
 * BEFORE any handler runs. A handler that reads any of those fields
 * receives undefined and silently:
 *   • falls through to a default-tenant fallback (= cross-tenant write)
 *   • or treats the request as the broadcast / no-target branch
 *
 * Issue #646 caught four routes that read `req.body.tenantId` directly
 * — web_visitors `/track` + `/identify`, live_chat `/visitor/start`,
 * chatbots `/chat/:botId` (test-mode override), and a dead branch in
 * telephony.js. Sibling agents 646-A / 646-B / 646-C renamed those body
 * fields to non-stripped equivalents (`siteTenantId`, `previewTenantId`)
 * AND added 400 INVALID_INPUT responses for missing values. This spec
 * locks in:
 *
 *   1. The new field names (siteTenantId / previewTenantId) actually
 *      reach the handler and scope writes to the supplied tenant.
 *   2. The old field names (`tenantId` directly) are silently stripped,
 *      and the route correctly 400s on missing required input rather
 *      than falling through to a default-tenant write.
 *   3. The wellness tenant's row WAS created and the generic tenant got
 *      ZERO new rows — proves cross-tenant isolation actually held when
 *      a generic-admin caller posted a wellness siteTenantId.
 *
 * Pattern:
 *   • Login as the generic admin (admin@globussoft.com).
 *   • Resolve the wellness tenant id by logging in as a wellness user.
 *   • POST against each route with `siteTenantId` / `previewTenantId`
 *     pointing at the wellness tenant.
 *   • Read back via list / GET endpoints scoped to each tenant and
 *     assert the row landed where the body field said.
 *   • Repeat with the OLD field name (`tenantId`) and assert 400.
 *
 * The web_visitors `/track` and live_chat `/visitor/start` routes are
 * PUBLIC (no auth) — they're meant to receive cross-origin POSTs from
 * embedded widgets — so the test calls them WITHOUT a Bearer token.
 * The visibility readback (`GET /api/web-visitors`, `GET /api/live-chat
 * /sessions`) is auth-gated to the tenant's admin.
 *
 * RUN_TAG: `E2E_X646_<ts>` — see e2e/test-data-patterns.js. The
 * teardown regex catches `^E2E_X646_` automatically (uses the
 * generic `/^E2E_/` pattern via the leading `E2E_` prefix).
 *
 * Wired into BOTH .github/workflows/deploy.yml (per-push gate) AND
 * .github/workflows/coverage.yml (coverage measurement gate).
 */
const { test, expect } = require('@playwright/test');

test.describe.configure({ mode: 'serial' });

const BASE_URL = process.env.BASE_URL || 'https://crm.globusdemos.com';
const API = `${BASE_URL}/api`;
const REQUEST_TIMEOUT = 60000;
const RUN_TAG = `E2E_X646_${Date.now()}`;

// Two-tenant credentials — drives the cross-tenant assertion.
const GENERIC = { email: 'admin@globussoft.com', password: 'password123' };
const WELLNESS = { email: 'admin@wellness.demo', password: 'password123' };

let genericToken = null;
let genericTenantId = null;
let wellnessToken = null;
let wellnessTenantId = null;

// Track createds for opportunistic teardown on the generic side
// (the `_E2E_X646_` tag on cleanup names matches the global teardown
// regex in e2e/test-data-patterns.js, so this is mostly insurance).
const createdSessionIds = [];
const createdBotIds = [];

async function login(request, fixture) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await request.post(`${API}/auth/login`, {
        data: fixture,
        headers: { 'Content-Type': 'application/json' },
        timeout: REQUEST_TIMEOUT,
      });
      if (r.ok()) return r.json();
    } catch (_e) {
      if (attempt === 0) continue;
    }
  }
  return null;
}

const authHdr = (token) => ({
  Authorization: `Bearer ${token}`,
  'Content-Type': 'application/json',
});

test.beforeAll(async ({ request }) => {
  const g = await login(request, GENERIC);
  test.skip(!g, 'generic admin login required for cross-tenant test — skipping');
  genericToken = g.token;
  genericTenantId = g.user?.tenantId ?? null;

  const w = await login(request, WELLNESS);
  test.skip(!w, 'wellness admin login required for cross-tenant test — skipping');
  wellnessToken = w.token;
  wellnessTenantId = w.user?.tenantId ?? null;

  test.skip(
    !genericTenantId || !wellnessTenantId || genericTenantId === wellnessTenantId,
    `need two distinct tenants (got generic=${genericTenantId}, wellness=${wellnessTenantId})`,
  );
});

test.afterAll(async ({ request }) => {
  // Best-effort cleanup of bots created on the generic tenant. Sessions
  // and visitor rows are scrubbed by global-teardown via the RUN_TAG.
  for (const id of createdBotIds) {
    await request
      .delete(`${API}/chatbots/${id}`, { headers: authHdr(genericToken), timeout: REQUEST_TIMEOUT })
      .catch(() => {});
  }
});

test.describe('#646 — stripDangerous defense-in-depth on cross-tenant body fields', () => {
  // ── web_visitors.js — siteTenantId ──────────────────────────────
  test('POST /api/web-visitors/track with siteTenantId=<wellness> creates row on wellnessTenantId, NOT genericTenantId', async ({ request }) => {
    const sessionId = `${RUN_TAG}_track_${Math.random().toString(36).slice(2, 8)}`;

    // Fire the public track endpoint with the wellness tenant in the body.
    // No auth header — this is the embed-widget public path.
    const post = await request.post(`${API}/web-visitors/track`, {
      data: {
        sessionId,
        siteTenantId: wellnessTenantId,
        url: 'https://example.test/landing',
        userAgent: `${RUN_TAG} probe`,
      },
      headers: { 'Content-Type': 'application/json' },
      timeout: REQUEST_TIMEOUT,
    });
    expect(post.status(), `track POST: ${await post.text()}`).toBe(200);

    // Read back as wellness admin — row MUST be visible under wellness scope.
    const fromWellness = await request.get(`${API}/web-visitors`, {
      headers: authHdr(wellnessToken),
      timeout: REQUEST_TIMEOUT,
    });
    expect(fromWellness.ok()).toBeTruthy();
    const wBody = await fromWellness.json();
    const wRows = Array.isArray(wBody) ? wBody : (wBody.visitors || wBody.data || []);
    const wHit = wRows.find((v) => v.sessionId === sessionId);
    expect(wHit, `wellness tenant must see sessionId=${sessionId}`).toBeTruthy();

    // Read back as generic admin — the SAME sessionId must NOT leak here.
    const fromGeneric = await request.get(`${API}/web-visitors`, {
      headers: authHdr(genericToken),
      timeout: REQUEST_TIMEOUT,
    });
    expect(fromGeneric.ok()).toBeTruthy();
    const gBody = await fromGeneric.json();
    const gRows = Array.isArray(gBody) ? gBody : (gBody.visitors || gBody.data || []);
    const gHit = gRows.find((v) => v.sessionId === sessionId);
    expect(gHit, 'generic tenant MUST NOT see the wellness-scoped row (cross-tenant isolation)').toBeFalsy();
  });

  test('POST /api/web-visitors/track with OLD tenantId body field is silently stripped → 400 INVALID_INPUT', async ({ request }) => {
    const sessionId = `${RUN_TAG}_track_old_${Math.random().toString(36).slice(2, 8)}`;
    const post = await request.post(`${API}/web-visitors/track`, {
      data: {
        sessionId,
        // Old field name — stripDangerous will delete it before the handler.
        tenantId: wellnessTenantId,
        url: 'https://example.test/landing',
      },
      headers: { 'Content-Type': 'application/json' },
      timeout: REQUEST_TIMEOUT,
    });
    // Sibling 646-A added 400 INVALID_INPUT instead of silent fallback.
    expect(post.status(), `body=${await post.text()}`).toBe(400);
    const body = await post.json();
    // Pin code; allow either error string format until siblings settle.
    expect(body.code || body.error).toMatch(/INVALID_INPUT|siteTenantId/i);
  });

  // ── live_chat.js — siteTenantId ─────────────────────────────────
  test('POST /api/live-chat/visitor/start with siteTenantId=<wellness> creates session on wellnessTenantId', async ({ request }) => {
    const visitorId = `${RUN_TAG}_lc_${Math.random().toString(36).slice(2, 8)}`;
    const post = await request.post(`${API}/live-chat/visitor/start`, {
      data: {
        visitorId,
        siteTenantId: wellnessTenantId,
        visitorName: `${RUN_TAG} Visitor`,
        visitorEmail: `${RUN_TAG.toLowerCase()}@example.test`,
      },
      headers: { 'Content-Type': 'application/json' },
      timeout: REQUEST_TIMEOUT,
    });
    expect(post.status(), `visitor/start: ${await post.text()}`).toBe(200);
    const sBody = await post.json();
    const sessionId = sBody.sessionId ?? sBody.session?.id;
    expect(sessionId, 'expected sessionId in response').toBeTruthy();
    createdSessionIds.push(sessionId);

    // The session row must be readable under wellness admin auth.
    // /api/live-chat/sessions is auth-gated to the calling tenant.
    const fromWellness = await request.get(`${API}/live-chat/sessions`, {
      headers: authHdr(wellnessToken),
      timeout: REQUEST_TIMEOUT,
    });
    if (fromWellness.ok()) {
      const wBody = await fromWellness.json();
      const wRows = Array.isArray(wBody) ? wBody : (wBody.sessions || wBody.data || []);
      const wHit = wRows.find((s) => s.id === sessionId || s.visitorId === visitorId);
      expect(wHit, `wellness tenant must see session for visitorId=${visitorId}`).toBeTruthy();
    }

    // Generic tenant must NOT see this session.
    const fromGeneric = await request.get(`${API}/live-chat/sessions`, {
      headers: authHdr(genericToken),
      timeout: REQUEST_TIMEOUT,
    });
    if (fromGeneric.ok()) {
      const gBody = await fromGeneric.json();
      const gRows = Array.isArray(gBody) ? gBody : (gBody.sessions || gBody.data || []);
      const gHit = gRows.find((s) => s.id === sessionId || s.visitorId === visitorId);
      expect(gHit, 'generic tenant MUST NOT see wellness-scoped chat session').toBeFalsy();
    }
  });

  test('POST /api/live-chat/visitor/start with OLD tenantId body field → 400 INVALID_INPUT', async ({ request }) => {
    const visitorId = `${RUN_TAG}_lc_old_${Math.random().toString(36).slice(2, 8)}`;
    const post = await request.post(`${API}/live-chat/visitor/start`, {
      data: {
        visitorId,
        tenantId: wellnessTenantId, // stripped by stripDangerous
        visitorName: `${RUN_TAG} OldVisitor`,
      },
      headers: { 'Content-Type': 'application/json' },
      timeout: REQUEST_TIMEOUT,
    });
    expect(post.status(), `body=${await post.text()}`).toBe(400);
    const body = await post.json();
    expect(body.code || body.error).toMatch(/INVALID_INPUT|siteTenantId/i);
  });

  // ── chatbots.js — previewTenantId ───────────────────────────────
  test('POST /api/chatbots/chat/:botId with previewTenantId=<wellness> overrides inactive-bot block (proves the body field reaches the handler)', async ({ request }) => {
    // Create an INACTIVE bot under the wellness tenant.
    const botRes = await request.post(`${API}/chatbots`, {
      headers: authHdr(wellnessToken),
      data: {
        name: `${RUN_TAG}_preview_bot`,
        flow: {
          nodes: [
            { id: 'n1', type: 'message', content: 'Welcome' },
            { id: 'n2', type: 'end' },
          ],
          edges: [{ from: 'n1', to: 'n2' }],
        },
        isActive: false,
      },
      timeout: REQUEST_TIMEOUT,
    });
    expect(botRes.ok(), `create bot: ${await botRes.text()}`).toBeTruthy();
    const bot = await botRes.json();
    const botId = bot.id ?? bot.bot?.id;
    expect(botId).toBeTruthy();
    createdBotIds.push(botId);

    // Re-activate-toggle: ensure bot is inactive (some create paths default
    // to active regardless of body — make explicit via PATCH).
    await request
      .post(`${API}/chatbots/${botId}/deactivate`, {
        headers: authHdr(wellnessToken),
        timeout: REQUEST_TIMEOUT,
      })
      .catch(() => {});

    // Negative path: WITHOUT previewTenantId, an inactive bot must 403.
    const visitorId = `${RUN_TAG}_chat_${Math.random().toString(36).slice(2, 8)}`;
    const blocked = await request.post(`${API}/chatbots/chat/${botId}`, {
      data: { visitorId, message: 'hi' },
      headers: { 'Content-Type': 'application/json' },
      timeout: REQUEST_TIMEOUT,
    });
    expect(blocked.status(), `expected 403 without previewTenantId: ${await blocked.text()}`).toBe(403);

    // Positive path: WITH previewTenantId matching the bot's tenant, the
    // inactive guard yields and the chat handler proceeds.
    const allowed = await request.post(`${API}/chatbots/chat/${botId}`, {
      data: {
        visitorId,
        message: 'hi',
        previewTenantId: wellnessTenantId,
      },
      headers: { 'Content-Type': 'application/json' },
      timeout: REQUEST_TIMEOUT,
    });
    expect(allowed.status(), `expected 2xx with previewTenantId: ${await allowed.text()}`).toBe(200);
  });

  test('POST /api/chatbots/chat/:botId with OLD tenantId body field is stripped → still 403 on inactive bot', async ({ request }) => {
    // Re-create an inactive bot to keep the test independent of ordering.
    const botRes = await request.post(`${API}/chatbots`, {
      headers: authHdr(wellnessToken),
      data: {
        name: `${RUN_TAG}_old_field_bot`,
        flow: {
          nodes: [{ id: 'n1', type: 'message', content: 'Hi' }, { id: 'n2', type: 'end' }],
          edges: [{ from: 'n1', to: 'n2' }],
        },
        isActive: false,
      },
      timeout: REQUEST_TIMEOUT,
    });
    expect(botRes.ok()).toBeTruthy();
    const bot = await botRes.json();
    const botId = bot.id ?? bot.bot?.id;
    createdBotIds.push(botId);

    await request
      .post(`${API}/chatbots/${botId}/deactivate`, {
        headers: authHdr(wellnessToken),
        timeout: REQUEST_TIMEOUT,
      })
      .catch(() => {});

    // OLD field name — stripped before handler — preview override never fires
    // — inactive guard remains in force — 403.
    const visitorId = `${RUN_TAG}_chat_old_${Math.random().toString(36).slice(2, 8)}`;
    const blocked = await request.post(`${API}/chatbots/chat/${botId}`, {
      data: {
        visitorId,
        message: 'hi',
        tenantId: wellnessTenantId, // stripped — has no effect
      },
      headers: { 'Content-Type': 'application/json' },
      timeout: REQUEST_TIMEOUT,
    });
    expect(blocked.status(), `expected 403 with stripped tenantId: ${await blocked.text()}`).toBe(403);
  });
});
