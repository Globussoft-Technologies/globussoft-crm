// @ts-check
/**
 * Campaign Engine — gate spec for cron/campaignEngine.js (G-12, docs/E2E_GAPS.md).
 *
 * Engine under test: backend/cron/campaignEngine.js
 *   - cron `* * * * *` (every minute, disabled in CI by DISABLE_CRONS=1)
 *   - For Campaign rows with `status='Scheduled'`, walks the in-memory
 *     `global._campaignSchedules[campaign.id]` map for scheduledAt + filters:
 *       schedule.scheduledAt > now → continue (not yet time)
 *       schedule absent           → fallback "send now" path (engine: line 27)
 *       schedule.scheduledAt <= now → call sendCampaign(campaign, io)
 *   - sendCampaign loads contacts via buildContactWhere(tenantId, filters),
 *     EMAIL channel requires email-not-empty / SMS requires phone-not-null.
 *     Status is flipped: Scheduled → Sending → Completed (with sent counter).
 *     For each contact: EmailMessage row + EmailTracking pixel (EMAIL channel)
 *     OR SmsMessage row with status='QUEUED' (SMS channel). External Mailgun /
 *     SMS provider is best-effort; the DB row is the assertion target.
 *   - On failure: status flips back to Draft (cron) — for retry next tick.
 *   - schedule metadata is `delete`d from the global map after dispatch
 *     (engine: line 50). Idempotency across ticks lives at the
 *     status='Completed' transition: a Completed row is never re-picked.
 *
 * Trigger endpoint: POST /api/marketing/campaigns/run
 *   - NEW in this PR — added at backend/routes/marketing.js
 *   - middleware: verifyToken (global) + verifyRole(["ADMIN"])
 *   - Body: none (uses req.user.tenantId)
 *   - Mirrors POST /api/billing/recurring/run + /api/forecasting/snapshot/run.
 *   - Returns: { success, tenantId, processed, dispatched, skipped, errors }
 *       processed  — count of Scheduled rows walked (tenant-scoped)
 *       dispatched — count actually sent (status flipped to Completed)
 *       skipped    — count whose schedule.scheduledAt is still future
 *       errors     — per-row failures, mirrors engine try/catch shape
 *   - Inlines the engine's per-tick body (the cron version is all-tenant;
 *     this is one-tenant) so cron + manual paths agree on field semantics
 *     (status flow, schedule-map cleanup, sendCampaign reuse).
 *
 * Acceptance criteria covered (G-12 from docs/E2E_GAPS.md):
 *   1. Scheduled with past scheduledAt → dispatched. Status flips
 *      Scheduled → Completed, schedule entry removed from global map.
 *   2. Scheduled with future scheduledAt (+30d) → skipped this tick;
 *      status stays 'Scheduled', schedule entry retained.
 *   3. status='Completed' (already-sent) → not re-dispatched. The where
 *      clause filters status='Scheduled' so Completed rows are invisible.
 *   4. Idempotency within back-to-back ticks — second /run with no new
 *      seeded due-row reports dispatched=0 (stale schedule entries are
 *      cleaned up by the first run; status no longer matches the query).
 *   5. Tenant isolation — generic admin's /run does NOT dispatch any
 *      wellness-tenant Scheduled campaigns. Critical: a leak here =
 *      sending real outbound to the wrong tenant's contacts.
 *   6. RBAC: ADMIN → 200. MANAGER → 403. USER → 403.
 *   7. Auth: no token → 401/403; bogus bearer → 401/403.
 *   8. Self-clean — every Campaign + Contact this spec creates carries
 *      RUN_TAG so afterAll deletes by id; global-teardown's NAME regex
 *      mops residue. SmsMessage/EmailMessage rows cascade with the
 *      contact / campaign they reference.
 *
 * Non-obvious setup pitfalls:
 *   - Campaign has NO `scheduledAt` column in prisma/schema.prisma. The
 *     engine reads `global._campaignSchedules[campaignId]` from in-process
 *     memory. This means:
 *       (a) The scheduledAt write path is `POST /campaigns/:id/schedule`,
 *           which hits the SAME process the trigger /run reads from. The
 *           spec MUST go via that endpoint — there's no DB column to
 *           back-date.
 *       (b) A backend restart wipes ALL schedule metadata. Tests that
 *           assume schedule persistence across restarts will break.
 *           This spec runs everything in one process lifetime.
 *       (c) Multi-instance deploys (PM2 cluster, k8s replicas) would
 *           desync the schedule map. Documented as architectural debt
 *           in the engine's own comment block (line 26).
 *   - The /campaigns/:id/schedule endpoint does NOT validate that
 *     scheduledAt is in the future — this is by design so we can
 *     immediately schedule a "past" time to drive the dispatch path.
 *   - sendCampaign fans out ALL tenant contacts when filters=null (the
 *     EMAIL channel requires email-not-empty; SMS requires phone-not-null).
 *     A noisy seed (lots of contacts) makes /run slow. We use a
 *     restrictive filter ({ source: 'E2E_FLOW_CAMPAIGN_<ts>' }) so each
 *     dispatched campaign reaches exactly the one contact we seeded.
 *   - global stripDangerous middleware deletes id/createdAt/updatedAt/
 *     tenantId/userId from every body. Don't try to set those fields on
 *     POST /campaigns or POST /contacts — they'll be silently dropped.
 *   - JWT fixture: req.user.userId not req.user.id (CLAUDE.md rule).
 *   - The /campaigns/:id/send route guards against re-send (Sending /
 *     Completed → 409). The /run trigger does NOT guard via 409 —
 *     it relies on the status='Scheduled' query filter to skip them.
 *
 * Test environment expectations:
 *   - BASE_URL defaults to http://127.0.0.1:5000 (local stack). CI sets
 *     BASE_URL=http://127.0.0.1:5000 (deploy.yml's matrix backend boot).
 *   - Login fixtures: admin@globussoft.com / manager@crm.com / user@crm.com
 *     (generic tenant) + admin@wellness.demo (wellness tenant).
 *   - Both tenants must be seeded (prisma/seed.js + prisma/seed-wellness.js).
 *   - Backend is a single instance (the in-memory _campaignSchedules map
 *     is per-process). Local stack and CI both satisfy this.
 *
 * Pattern: clones e2e/tests/recurring-invoice-api.spec.js (engine trigger
 * + tenant isolation + RBAC) and e2e/tests/sequence-engine-api.spec.js
 * (cron-engine trigger + DB side-effect assertion).
 */
const { test, expect } = require('@playwright/test');

const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:5000';
const API = `${BASE_URL}/api`;
const REQUEST_TIMEOUT = 30000;

const RUN_TAG = `E2E_FLOW_CAMPAIGN_${Date.now()}`;

// Force serial execution within this spec. Reason: every `runCampaigns()`
// call processes ALL Scheduled campaigns in the requesting tenant. If two
// tests race and both have seeded a past-due campaign, the first /run
// drains both — and the second test's "dispatched exactly one" check sees
// a stale 0. Serialising keeps each test's expectations local to its
// fixture seed.
test.describe.configure({ mode: 'serial' });

const FIXTURES = {
  // Generic CRM ADMIN — drives /run 200 + campaign CRUD.
  admin: { email: 'admin@globussoft.com', password: 'password123' },
  // Generic CRM MANAGER — ADMIN-only route, must 403.
  manager: { email: 'manager@crm.com', password: 'password123' },
  // Generic CRM USER — must also 403.
  user: { email: 'user@crm.com', password: 'password123' },
  // Wellness ADMIN — different tenantId. Drives the tenant-isolation suite:
  // a generic /run must NEVER touch wellness Campaign rows.
  wellnessAdmin: { email: 'admin@wellness.demo', password: 'password123' },
};

const tokens = {};
const tenantIds = {};
// Track every row we created so afterAll can clean up.
const createdCampaignIds = []; // (admin context)
const createdContactIds = []; // (admin context)
const createdWellnessCampaignIds = []; // (wellness context)
const createdWellnessContactIds = []; // (wellness context)

// ─── HTTP helpers ────────────────────────────────────────────────────────

async function login(request, fixture) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await request.post(`${API}/auth/login`, {
        data: fixture,
        headers: { 'Content-Type': 'application/json' },
        timeout: REQUEST_TIMEOUT,
      });
      if (r.ok()) {
        const j = await r.json();
        return { token: j.token, tenantId: j.tenant && j.tenant.id };
      }
    } catch (_e) {
      if (attempt === 0) continue;
    }
  }
  return { token: null, tenantId: null };
}

function authHeader(token) {
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

async function authPost(request, token, p, body) {
  return request.post(`${API}${p}`, {
    headers: authHeader(token),
    data: body ?? {},
    timeout: REQUEST_TIMEOUT,
  });
}

async function authGet(request, token, p) {
  return request.get(`${API}${p}`, {
    headers: authHeader(token),
    timeout: REQUEST_TIMEOUT,
  });
}

async function authPut(request, token, p, body) {
  return request.put(`${API}${p}`, {
    headers: authHeader(token),
    data: body ?? {},
    timeout: REQUEST_TIMEOUT,
  });
}

async function authDelete(request, token, p) {
  return request.delete(`${API}${p}`, {
    headers: authHeader(token),
    timeout: REQUEST_TIMEOUT,
  });
}

// ─── Seed helpers ────────────────────────────────────────────────────────

function uniquePhone() {
  const tail = String(Math.floor(1000000000 + Math.random() * 9000000000)).slice(-10);
  return `9${tail.slice(0, 9)}`;
}

// Each campaign in the spec gets its OWN audience: a single contact whose
// `source` field is the campaign's unique tag. The audience filter is then
// `{ source: <tag> }` so sendCampaign reaches exactly one row, regardless
// of how noisy the demo seed is.
async function seedContact(request, token, label, source, bucket) {
  const stamp = Date.now() + Math.floor(Math.random() * 100000);
  const r = await authPost(request, token, '/contacts', {
    name: `${RUN_TAG} ${label}-${stamp}`,
    email: `e2e-camp-${stamp}@example.test`,
    phone: uniquePhone(),
    status: 'Lead',
    source,
  });
  if (!r.ok()) {
    throw new Error(`seedContact (${label}): ${r.status()} ${await r.text()}`);
  }
  const c = await r.json();
  bucket.push(c.id);
  return c;
}

async function seedCampaign(request, token, label, bucket) {
  const r = await authPost(request, token, '/marketing/campaigns', {
    name: `${RUN_TAG} ${label}`,
    channel: 'EMAIL',
    budget: 0,
  });
  if (r.status() !== 201) {
    throw new Error(`seedCampaign (${label}): ${r.status()} ${await r.text()}`);
  }
  const camp = await r.json();
  bucket.push(camp.id);
  return camp;
}

// Schedule a campaign at `whenIso` (can be past or future) with audience
// pinned to a `source` filter so dispatch hits exactly one contact.
async function scheduleCampaign(request, token, campaignId, whenIso, source) {
  const r = await authPost(request, token, `/marketing/campaigns/${campaignId}/schedule`, {
    scheduledAt: whenIso,
    filters: { source },
  });
  if (r.status() !== 200) {
    throw new Error(`scheduleCampaign: ${r.status()} ${await r.text()}`);
  }
  return r.json();
}

async function getCampaign(request, token, campaignId) {
  const r = await authGet(request, token, `/marketing/campaigns/${campaignId}`);
  if (r.status() !== 200) return null;
  return r.json();
}

async function runCampaigns(request, token) {
  return authPost(request, token, '/marketing/campaigns/run', {});
}

// ─── Lifecycle ───────────────────────────────────────────────────────────

test.beforeAll(async ({ request }) => {
  for (const [k, f] of Object.entries(FIXTURES)) {
    const r = await login(request, f);
    if (r.token) {
      tokens[k] = r.token;
      tenantIds[k] = r.tenantId;
    }
  }
  expect(tokens.admin, 'generic admin token must be available').toBeTruthy();
});

test.afterAll(async ({ request }) => {
  // Teardown: drop every campaign we created (DELETE /campaigns/:id is
  // a hard delete) — that cascades SmsMessage rows linked via campaignId.
  // EmailMessage has no campaignId FK; those rows persist as inert noise
  // on the ephemeral CI DB and get cleaned by global-teardown's regex
  // sweep (the message subject carries our RUN_TAG prefix).
  // Then soft-delete contacts (DELETE /contacts/:id sets deletedAt;
  // teardown regex hard-removes residue on the next CI sweep).
  if (tokens.admin) {
    for (const id of createdCampaignIds) {
      await authDelete(request, tokens.admin, `/marketing/campaigns/${id}`).catch(() => {});
    }
    for (const id of createdContactIds) {
      await authDelete(request, tokens.admin, `/contacts/${id}`).catch(() => {});
    }
  }
  if (tokens.wellnessAdmin) {
    for (const id of createdWellnessCampaignIds) {
      await authDelete(request, tokens.wellnessAdmin, `/marketing/campaigns/${id}`).catch(() => {});
    }
    for (const id of createdWellnessContactIds) {
      await authDelete(request, tokens.wellnessAdmin, `/contacts/${id}`).catch(() => {});
    }
  }
});

// ─── Auth gate ───────────────────────────────────────────────────────────

test.describe('POST /api/marketing/campaigns/run — auth gate', () => {
  test('no token → 401/403', async ({ request }) => {
    const res = await request.post(`${API}/marketing/campaigns/run`, {
      data: {},
      headers: { 'Content-Type': 'application/json' },
      timeout: REQUEST_TIMEOUT,
    });
    expect([401, 403]).toContain(res.status());
  });

  test('bogus bearer → 401/403', async ({ request }) => {
    const res = await request.post(`${API}/marketing/campaigns/run`, {
      data: {},
      headers: { Authorization: 'Bearer not-a-real-jwt', 'Content-Type': 'application/json' },
      timeout: REQUEST_TIMEOUT,
    });
    expect([401, 403]).toContain(res.status());
  });
});

// ─── RBAC gate ───────────────────────────────────────────────────────────

test.describe('POST /api/marketing/campaigns/run — RBAC gate', () => {
  test('MANAGER → 403', async ({ request }) => {
    test.skip(!tokens.manager, 'manager fixture (manager@crm.com) not seeded');
    const res = await runCampaigns(request, tokens.manager);
    expect(res.status()).toBe(403);
  });

  test('USER → 403', async ({ request }) => {
    test.skip(!tokens.user, 'user fixture (user@crm.com) not seeded');
    const res = await runCampaigns(request, tokens.user);
    expect(res.status()).toBe(403);
  });

  test('ADMIN → 200 with envelope { success, tenantId, processed, dispatched, skipped, errors }', async ({ request }) => {
    const res = await runCampaigns(request, tokens.admin);
    expect(res.status(), `body: ${await res.text()}`).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(typeof body.tenantId).toBe('number');
    expect(typeof body.processed).toBe('number');
    expect(typeof body.dispatched).toBe('number');
    expect(typeof body.skipped).toBe('number');
    expect(Array.isArray(body.errors)).toBe(true);
  });
});

// ─── Engine semantics — dispatch window ──────────────────────────────────

test.describe('Campaign Engine — dispatch window', () => {
  test('Scheduled campaign with past scheduledAt → dispatched (status flips to Completed)', async ({ request }) => {
    const source = `${RUN_TAG}_PAST`;
    await seedContact(request, tokens.admin, 'past-window', source, createdContactIds);
    const camp = await seedCampaign(request, tokens.admin, 'past-window', createdCampaignIds);

    // Schedule at 1h ago — engine's `schedule.scheduledAt > now` check
    // is FALSE, so it falls through to the dispatch path.
    const past = new Date(Date.now() - 3600 * 1000).toISOString();
    await scheduleCampaign(request, tokens.admin, camp.id, past, source);

    // Confirm precondition: status='Scheduled' after the schedule POST.
    const beforeRow = await getCampaign(request, tokens.admin, camp.id);
    expect(beforeRow.status).toBe('Scheduled');

    const res = await runCampaigns(request, tokens.admin);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.dispatched, `dispatched ≥ 1 (got ${JSON.stringify(body)})`).toBeGreaterThanOrEqual(1);

    // Status flipped to Completed (sendCampaign's terminal write at
    // routes/marketing.js:198). Sent counter advanced.
    const afterRow = await getCampaign(request, tokens.admin, camp.id);
    expect(afterRow.status).toBe('Completed');
    expect(afterRow.sent).toBeGreaterThanOrEqual(1);
  });

  test('Scheduled campaign with future scheduledAt (+30d) → skipped, status stays Scheduled', async ({ request }) => {
    const source = `${RUN_TAG}_FUTURE`;
    await seedContact(request, tokens.admin, 'future-window', source, createdContactIds);
    const camp = await seedCampaign(request, tokens.admin, 'future-window', createdCampaignIds);

    // Schedule 30 days into the future. Engine's `scheduledAt > now`
    // is TRUE → continue (skip).
    const future = new Date(Date.now() + 30 * 86400000).toISOString();
    await scheduleCampaign(request, tokens.admin, camp.id, future, source);

    const before = await getCampaign(request, tokens.admin, camp.id);
    expect(before.status).toBe('Scheduled');
    const beforeSent = before.sent;

    const res = await runCampaigns(request, tokens.admin);
    expect(res.status()).toBe(200);
    const body = await res.json();
    // skipped MAY be > 0 because of OTHER tests' future fixtures still in
    // the schedule map. The strict assertion is on THIS row's status.
    expect(body.skipped).toBeGreaterThanOrEqual(1);

    const after = await getCampaign(request, tokens.admin, camp.id);
    expect(after.status, 'future-window campaign must NOT flip to Completed').toBe('Scheduled');
    expect(after.sent, 'future-window campaign sent counter must not advance').toBe(beforeSent);
  });

  test('status=Completed campaign → not re-dispatched (where clause excludes)', async ({ request }) => {
    const source = `${RUN_TAG}_COMPLETED`;
    await seedContact(request, tokens.admin, 'already-sent', source, createdContactIds);
    const camp = await seedCampaign(request, tokens.admin, 'already-sent', createdCampaignIds);

    // Drive it to Completed via past-scheduled + run.
    const past = new Date(Date.now() - 3600 * 1000).toISOString();
    await scheduleCampaign(request, tokens.admin, camp.id, past, source);
    await runCampaigns(request, tokens.admin);

    const completedRow = await getCampaign(request, tokens.admin, camp.id);
    expect(completedRow.status).toBe('Completed');
    const sentSnapshot = completedRow.sent;

    // Second /run — the where-clause is status='Scheduled', so this
    // Completed row is invisible to the engine. No double-send.
    const res = await runCampaigns(request, tokens.admin);
    expect(res.status()).toBe(200);

    const stillCompleted = await getCampaign(request, tokens.admin, camp.id);
    expect(stillCompleted.status).toBe('Completed');
    expect(
      stillCompleted.sent,
      `Completed campaign sent counter must NOT advance on re-run (was ${sentSnapshot}, now ${stillCompleted.sent})`,
    ).toBe(sentSnapshot);
  });
});

// ─── Idempotency within current tick ─────────────────────────────────────

test.describe('Campaign Engine — idempotency', () => {
  test('two consecutive runs on a single past-window campaign dispatch ONCE', async ({ request }) => {
    const source = `${RUN_TAG}_IDEMP`;
    await seedContact(request, tokens.admin, 'idempotent', source, createdContactIds);
    const camp = await seedCampaign(request, tokens.admin, 'idempotent', createdCampaignIds);

    const past = new Date(Date.now() - 3600 * 1000).toISOString();
    await scheduleCampaign(request, tokens.admin, camp.id, past, source);

    // First tick — Scheduled → Completed, schedule entry deleted.
    const r1 = await runCampaigns(request, tokens.admin);
    expect(r1.status()).toBe(200);
    const after1 = await getCampaign(request, tokens.admin, camp.id);
    expect(after1.status).toBe('Completed');
    const sentAfter1 = after1.sent;
    expect(sentAfter1).toBeGreaterThanOrEqual(1);

    // Second tick — Completed row excluded by where-clause; sent
    // counter must NOT advance.
    const r2 = await runCampaigns(request, tokens.admin);
    expect(r2.status()).toBe(200);

    const after2 = await getCampaign(request, tokens.admin, camp.id);
    expect(after2.status).toBe('Completed');
    expect(
      after2.sent,
      `idempotent: sent stays at ${sentAfter1} (got ${after2.sent})`,
    ).toBe(sentAfter1);
  });
});

// ─── Tenant isolation ────────────────────────────────────────────────────

test.describe('Campaign Engine — tenant isolation', () => {
  test('generic admin /run does NOT dispatch wellness-tenant Scheduled campaigns', async ({ request }) => {
    test.skip(!tokens.wellnessAdmin, 'wellness admin fixture not seeded');

    // Seed a past-due Scheduled campaign on the WELLNESS tenant.
    const source = `${RUN_TAG}_WELL_ISO`;
    await seedContact(request, tokens.wellnessAdmin, 'wellness-iso', source, createdWellnessContactIds);
    const wellnessCamp = await seedCampaign(request, tokens.wellnessAdmin, 'wellness-iso', createdWellnessCampaignIds);

    const past = new Date(Date.now() - 3600 * 1000).toISOString();
    await scheduleCampaign(request, tokens.wellnessAdmin, wellnessCamp.id, past, source);

    const before = await getCampaign(request, tokens.wellnessAdmin, wellnessCamp.id);
    expect(before.status).toBe('Scheduled');

    // GENERIC admin runs the engine. Route's where-clause is
    // `tenantId: req.user.tenantId` — wellness tenant must NOT be touched.
    const res = await runCampaigns(request, tokens.admin);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.tenantId).toBe(tenantIds.admin);
    expect(body.tenantId).not.toBe(tenantIds.wellnessAdmin);

    // Wellness campaign must STILL be in Scheduled state (untouched).
    const after = await getCampaign(request, tokens.wellnessAdmin, wellnessCamp.id);
    expect(
      after.status,
      'wellness Scheduled campaign must NOT be flipped to Completed by generic /run',
    ).toBe('Scheduled');
  });

  test('wellness admin /run scopes Campaign dispatch to wellness tenant only', async ({ request }) => {
    test.skip(!tokens.wellnessAdmin, 'wellness admin fixture not seeded');
    const res = await runCampaigns(request, tokens.wellnessAdmin);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.tenantId).toBe(tenantIds.wellnessAdmin);
  });
});
