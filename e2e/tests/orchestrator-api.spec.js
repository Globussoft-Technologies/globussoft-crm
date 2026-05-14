// @ts-check
/**
 * Orchestrator engine API gate spec — regression-coverage-backlog item #16.
 *
 * Closes: #261, #276, #308, #319, #321
 *
 * Target: backend/cron/orchestratorEngine.js (~615 lines) + the four
 * recommendation-lifecycle endpoints in backend/routes/wellness.js:
 *   POST   /api/wellness/orchestrator/run                 — admin/manager trigger
 *   GET    /api/wellness/recommendations?status=…         — list (with collapse-by-key dedup)
 *   POST   /api/wellness/recommendations/:id/approve      — race-safe pending→approved
 *   POST   /api/wellness/recommendations/:id/reject       — race-safe pending→rejected
 *   PUT    /api/wellness/recommendations/:id              — pending-only amend (ADMIN/MANAGER)
 *   GET    /api/audit-viewer?entity=AgentRecommendation   — verifies #179 audit emission
 *
 * Why this exists (the regression class each acceptance bullet pins):
 *
 *   #261 / #308 — One day's run produces at most one row per
 *                 (tenantId, type, normalised-title). Pre-fix the cron's
 *                 in-memory `seen` set only checked status=pending rows,
 *                 so an approved card from earlier today re-emitted on
 *                 the next manual trigger. The current dedup keys on
 *                 (type + payloadHash) AND (type + title-prefix) and is
 *                 scoped to today's createdAt window — a second
 *                 /orchestrator/run within the same UTC day MUST yield
 *                 created=0. The collapse-by-key in GET /recommendations
 *                 ALSO ensures a logical card never appears in two tabs
 *                 (Pending AND Rejected) at once.
 *
 *   #276 — Reject button writes status=REJECTED and emits an AuditLog row.
 *          Pre-fix the writeAudit('AgentRecommendation', 'REJECT', …) call
 *          was missing and the action was forensically silent. The
 *          current handler invokes writeAudit AFTER the race-safe flip
 *          (so a no-op re-reject does NOT generate a duplicate log row)
 *          and the audit blob carries title + priority + reason — never
 *          full payload (no PII / no credentials surface).
 *
 *   #319 — Generated card text never contains seed-pollution patterns
 *          (`Lifecycle \\d+`, `E2E_`, `Tenant B scoped`). The orchestrator
 *          reads context from real Visit / Contact / Service / Location
 *          rows; if a previous test leaks a fixture that survives into
 *          the rule-based proposal generator, the resulting card title /
 *          body would carry the test marker into the owner's morning
 *          dashboard. This pin guards against that pollution path.
 *
 *   #321 — Cost arithmetic doesn't overflow. The expectedImpact /
 *          suggestedDailyBudget / weekRevenue figures cap below 1e10 ₹
 *          (₹100 cr — well above any realistic single-clinic week).
 *          A previous regression had a multiplication using (basePrice *
 *          serviceCount * weeks) without bounds — when a stale seed had
 *          basePrice=2L AND a high count this could yield 2e11 and
 *          silently break PDF / SMS rendering downstream.
 *
 * Acceptance per bullet — each test is tagged in its title with the
 * issue number so the git-blame trail is obvious if a future regression
 * lands.
 *
 * State-machine contract (what the route ACTUALLY does, not what gap
 * cards may say — verified live against backend on 2026-05-07):
 *
 *   /approve:
 *     pending → approved (200, dispatcher fires, audit row written)
 *     approved → 200 + idempotent:true (NO double-dispatch, NO audit row)
 *     rejected → 422 INVALID_RECOMMENDATION_TRANSITION
 *
 *   /reject:
 *     pending → rejected (200, audit row written)
 *     rejected → 200 + idempotent:true (NO double-audit)
 *     approved → 422 INVALID_RECOMMENDATION_TRANSITION
 *
 *   GET /recommendations:
 *     ?status=pending|approved|rejected|snoozed|all
 *     Collapses (type::title.lowercased) groups; one logical card never
 *     surfaces under two status tabs simultaneously. STATUS_RANK prefers
 *     terminal (rejected > approved > snoozed > pending) representatives.
 *
 *   POST /orchestrator/run:
 *     - verifyWellnessRole(["admin","manager"]) — generic-tenant ADMIN
 *       gets 403 WELLNESS_TENANT_REQUIRED; doctor/professional/telecaller
 *       wellness USER gets 403 WELLNESS_ROLE_FORBIDDEN.
 *     - Idempotent within the same UTC day for a stable context: second
 *       trigger returns created=0 because the dedup keys match.
 *     - contextSummary string carries today's visits / utilisation% /
 *       open-leads / aging-leads / SLA-breach / week-revenue.
 *
 * Non-obvious setup pitfalls:
 *   - The wellness-tenant seed must include rishu@enhancedwellness.in
 *     OR admin@wellness.demo. We use admin@wellness.demo for the
 *     deterministic ADMIN role and rishu where we need the orchestrator
 *     to see real seeded leads (rishu's tenant is fully populated).
 *   - The orchestrator stores payload as JSON-string (Prisma column
 *     `String? @db.Text`) — every card we read MUST JSON.parse(payload)
 *     before inspecting the inner shape.
 *   - The /recommendations GET endpoint ALSO collapses across status=all
 *     by `${type}::${title.lowercased}` — when asserting "no row in two
 *     tabs", count the SAME id across pending/approved/rejected lists
 *     rather than asserting count-equality (a collapsed group might keep
 *     a different representative id under each tab).
 *   - The seed contains 3 pre-existing recommendations (ids 32/33/34
 *     from prisma/seed-wellness.js). They are pending and stable. We
 *     don't mutate or assume their ids — only assert against new rows
 *     we either created via /orchestrator/run or surfaced from the
 *     backlog list. Cleanup soft-rejects new pending rows we
 *     surfaced so demo-hygiene-api doesn't see test residue.
 *   - This spec runs against the LOCAL stack only when DISABLE_CRONS=1.
 *     In e2e-full against demo, the daily 07:00 IST cron may have
 *     fired and dropped real cards in. Per the demo-state-aware
 *     standing rule we never assert `count === beforeCount + delta`
 *     style equalities; we assert presence of specific rows we
 *     ourselves caused (via /orchestrator/run on the very same
 *     request loop).
 *
 * Test environment:
 *   - BASE_URL defaults to http://127.0.0.1:5000 (local stack).
 *   - Local: cd e2e && BASE_URL=http://127.0.0.1:5000 \
 *            npx playwright test --project=chromium --no-deps \
 *            tests/orchestrator-api.spec.js
 *   - Login fixtures (per backend/prisma/seed-wellness.js):
 *       admin@wellness.demo            wellness ADMIN
 *       admin@globussoft.com           generic ADMIN
 *       drharsh@enhancedwellness.in    wellness USER + wellnessRole=doctor
 *
 * RUN_TAG: `E2E_FLOW_ORCH_<ts>` — matches `^E2E_FLOW_/` in
 * e2e/test-data-patterns.js, so global-teardown sweeps any stragglers.
 *
 * Cleanup: every recommendation we surface (created via /orchestrator/run
 * inside this spec) is soft-rejected on afterAll so it falls out of the
 * Owner Dashboard's Pending tab. We do NOT hard-delete (there's no DELETE
 * endpoint on /recommendations) — the rejected status is the natural
 * "off the queue" state the route exposes.
 *
 * Pattern: cloned from
 *   - e2e/tests/wellness-clinical-api.spec.js (wellness-tenant test setup)
 *   - e2e/tests/wellness-rbac-regression-api.spec.js (revert-and-prove
 *     discipline + per-issue test tagging)
 *   - e2e/tests/wellness-ops-api.spec.js (cron-engine spec shape)
 */
const { test, expect } = require('@playwright/test');

// Several tests below trigger the orchestrator and read its output back —
// pin to serial to avoid worker-shuffle races on the dedup state.
test.describe.configure({ mode: 'serial' });

const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:5000';
const API = `${BASE_URL}/api`;
const REQUEST_TIMEOUT = 60000;
const RUN_TAG = `E2E_FLOW_ORCH_${Date.now()}`;
// Local-stack DB is clean; demo accumulates pre-existing pollution from
// prior test runs. The "scan ALL current rows" pollution test assumes a
// clean baseline — use IS_LOCAL_STACK to gate it.
const IS_LOCAL_STACK = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/.test(BASE_URL);

const FIXTURES = {
  wellnessAdmin:  { email: 'admin@wellness.demo',           password: 'password123' },
  genericAdmin:   { email: 'admin@globussoft.com',          password: 'password123' },
  doctor:         { email: 'drharsh@enhancedwellness.in',   password: 'password123' },
};

const tokens = {};

async function login(request, fixtureKey) {
  if (tokens[fixtureKey]) return tokens[fixtureKey];
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await request.post(`${API}/auth/login`, {
        data: FIXTURES[fixtureKey],
        headers: { 'Content-Type': 'application/json' },
        timeout: REQUEST_TIMEOUT,
      });
      if (r.ok()) {
        const body = await r.json();
        tokens[fixtureKey] = body.token;
        return body.token;
      }
    } catch (_) { /* retry once */ }
  }
  throw new Error(`login failed for ${fixtureKey}`);
}

const auth = (tok) => ({ Authorization: `Bearer ${tok}` });

async function authGet(request, path, fixtureKey = 'wellnessAdmin') {
  const tok = await login(request, fixtureKey);
  return request.get(`${BASE_URL}${path}`, {
    headers: auth(tok),
    timeout: REQUEST_TIMEOUT,
  });
}

async function authPost(request, path, body, fixtureKey = 'wellnessAdmin') {
  const tok = await login(request, fixtureKey);
  return request.post(`${BASE_URL}${path}`, {
    headers: { ...auth(tok), 'Content-Type': 'application/json' },
    data: body ?? {},
    timeout: REQUEST_TIMEOUT,
  });
}

async function authPut(request, path, body, fixtureKey = 'wellnessAdmin') {
  const tok = await login(request, fixtureKey);
  return request.put(`${BASE_URL}${path}`, {
    headers: { ...auth(tok), 'Content-Type': 'application/json' },
    data: body ?? {},
    timeout: REQUEST_TIMEOUT,
  });
}

// ── Cleanup tracking ────────────────────────────────────────────────
// We track the ids of every NEW pending recommendation surfaced inside
// this spec so afterAll can soft-reject them (no DELETE endpoint exists).
// Rejected rows fall out of the Owner Dashboard's pending tab — that's
// the natural "off the queue" state the route exposes.
const surfacedRecIds = new Set();

test.afterAll(async ({ request }) => {
  for (const id of surfacedRecIds) {
    await authPost(request, `/api/wellness/recommendations/${id}/reject`, {
      reason: `${RUN_TAG} teardown`,
    }).catch(() => {});
  }
});

// Helper: fetch all (status=all) recommendations for the wellness tenant.
async function listAllRecs(request, fixtureKey = 'wellnessAdmin') {
  const r = await authGet(request, '/api/wellness/recommendations?status=all', fixtureKey);
  expect(r.status()).toBe(200);
  const list = await r.json();
  expect(Array.isArray(list)).toBe(true);
  return list;
}

// Helper: trigger orchestrator run + return both the run summary and
// the freshly-listed recommendations (status=all).
async function runAndList(request) {
  const r = await authPost(request, '/api/wellness/orchestrator/run', {});
  expect(r.status(), `run: ${await r.text()}`).toBe(200);
  const summary = await r.json();
  const rows = await listAllRecs(request);
  // Track rows that are still pending so afterAll cleans them up.
  for (const row of rows) {
    if (row.status === 'pending') surfacedRecIds.add(row.id);
  }
  return { summary, rows };
}

// =====================================================================
// Acceptance #261 / #308 — Idempotency: at most one row per
// (tenantId, recommendationType, normalised-title) per UTC day.
// =====================================================================

test.describe('Orchestrator API — idempotency (#261, #308)', () => {
  test('first /orchestrator/run yields a numeric `created` count + summary string', async ({ request }) => {
    const r = await authPost(request, '/api/wellness/orchestrator/run', {});
    expect(r.status(), `run: ${await r.text()}`).toBe(200);
    const body = await r.json();
    expect(typeof body.created).toBe('number');
    expect(body.created).toBeGreaterThanOrEqual(0);
    expect(typeof body.contextSummary).toBe('string');
    expect(body.contextSummary.length).toBeGreaterThan(10);
  });

  test('second /orchestrator/run within the same UTC day yields created=0 (#261)', async ({ request }) => {
    // First run primes / refreshes today's set.
    await authPost(request, '/api/wellness/orchestrator/run', {});
    // Second run MUST be a no-op for the dedup keys.
    const r2 = await authPost(request, '/api/wellness/orchestrator/run', {});
    expect(r2.status()).toBe(200);
    const body = await r2.json();
    expect(body.created, `second run should dedupe but created=${body.created}`).toBe(0);
  });

  test('third /orchestrator/run still yields created=0 (#261 — durability across multiple ticks)', async ({ request }) => {
    await authPost(request, '/api/wellness/orchestrator/run', {});
    const r = await authPost(request, '/api/wellness/orchestrator/run', {});
    const body = await r.json();
    expect(body.created).toBe(0);
  });

  test('today\'s rows have at most one (type + lowercased-title) per group (#261, #308)', async ({ request }) => {
    await authPost(request, '/api/wellness/orchestrator/run', {});
    const all = await listAllRecs(request);
    // The GET endpoint already collapses (type::lc-title) → one rep per
    // group. Verify the post-collapse list has unique keys.
    const seen = new Map();
    for (const row of all) {
      const key = `${row.type || ''}::${(row.title || '').trim().toLowerCase()}`;
      const prev = seen.get(key);
      expect(prev, `duplicate (type+title) survived response-level dedup: id=${row.id} key="${key}" earlier id=${prev}`).toBeUndefined();
      seen.set(key, row.id);
    }
  });

  test('contextSummary references utilisation + lead counts (cron-engine context surface)', async ({ request }) => {
    const r = await authPost(request, '/api/wellness/orchestrator/run', {});
    const body = await r.json();
    expect(body.contextSummary.toLowerCase()).toContain('utilisation');
    expect(body.contextSummary.toLowerCase()).toMatch(/lead/);
  });
});

// =====================================================================
// Acceptance #308 — Status is exclusive: a logical card NEVER appears in
// two status tabs simultaneously.
// =====================================================================

test.describe('Orchestrator API — status exclusivity (#308)', () => {
  test('every status returns rows whose own status field matches the filter', async ({ request }) => {
    for (const status of ['pending', 'approved', 'rejected', 'snoozed']) {
      const r = await authGet(request, `/api/wellness/recommendations?status=${status}`);
      expect(r.status(), `${status}: ${await r.text()}`).toBe(200);
      const list = await r.json();
      for (const row of list) {
        expect(row.status, `row id=${row.id} returned in ?status=${status} but actual status=${row.status}`).toBe(status);
      }
    }
  });

  test('an id never appears in two terminal-vs-pending tabs at once (#308)', async ({ request }) => {
    await authPost(request, '/api/wellness/orchestrator/run', {});
    const [pendingR, approvedR, rejectedR] = await Promise.all([
      authGet(request, '/api/wellness/recommendations?status=pending'),
      authGet(request, '/api/wellness/recommendations?status=approved'),
      authGet(request, '/api/wellness/recommendations?status=rejected'),
    ]);
    const pendingIds = (await pendingR.json()).map((r) => r.id);
    const approvedIds = (await approvedR.json()).map((r) => r.id);
    const rejectedIds = (await rejectedR.json()).map((r) => r.id);
    const overlap = (a, b) => a.filter((id) => b.includes(id));
    expect(overlap(pendingIds, approvedIds), 'id appeared in BOTH pending and approved').toEqual([]);
    expect(overlap(pendingIds, rejectedIds), 'id appeared in BOTH pending and rejected').toEqual([]);
    expect(overlap(approvedIds, rejectedIds), 'id appeared in BOTH approved and rejected').toEqual([]);
  });

  test('after rejecting a card it disappears from ?status=pending (#308)', async ({ request }) => {
    const { rows } = await runAndList(request);
    const target = rows.find((r) => r.status === 'pending');
    if (!target) test.skip(true, 'no pending row available to reject');
    const r = await authPost(request, `/api/wellness/recommendations/${target.id}/reject`, { reason: `${RUN_TAG} status-test` });
    expect(r.status()).toBe(200);
    surfacedRecIds.delete(target.id); // we just rejected it; afterAll skip
    const after = await authGet(request, '/api/wellness/recommendations?status=pending');
    const afterList = await after.json();
    const stillPending = afterList.find((row) => row.id === target.id);
    expect(stillPending, `id=${target.id} should be gone from pending after reject`).toBeUndefined();
  });

  test('approving a rejected card → 422 INVALID_RECOMMENDATION_TRANSITION (state machine, #195)', async ({ request }) => {
    // Find a rejected row (or reject one ourselves).
    let rejected = (await (await authGet(request, '/api/wellness/recommendations?status=rejected')).json())[0];
    if (!rejected) {
      const { rows } = await runAndList(request);
      const target = rows.find((r) => r.status === 'pending');
      if (!target) test.skip(true, 'no pending to reject and no rejected available');
      const rej = await authPost(request, `/api/wellness/recommendations/${target.id}/reject`, { reason: `${RUN_TAG} for-422` });
      expect(rej.status()).toBe(200);
      surfacedRecIds.delete(target.id);
      rejected = await rej.json();
    }
    const r = await authPost(request, `/api/wellness/recommendations/${rejected.id}/approve`, {});
    expect(r.status()).toBe(422);
    const body = await r.json();
    expect(body.code).toBe('INVALID_RECOMMENDATION_TRANSITION');
    expect(body.currentStatus).toBe('rejected');
  });

  test('re-rejecting an already-rejected card is idempotent (200 + idempotent:true)', async ({ request }) => {
    // Pick a rejected one (or create+reject).
    let rejected = (await (await authGet(request, '/api/wellness/recommendations?status=rejected')).json())[0];
    if (!rejected) {
      const { rows } = await runAndList(request);
      const target = rows.find((r) => r.status === 'pending');
      if (!target) test.skip(true, 'no pending available');
      const rej = await authPost(request, `/api/wellness/recommendations/${target.id}/reject`, { reason: `${RUN_TAG} idem` });
      expect(rej.status()).toBe(200);
      surfacedRecIds.delete(target.id);
      rejected = await rej.json();
    }
    const r = await authPost(request, `/api/wellness/recommendations/${rejected.id}/reject`, { reason: 're-reject' });
    expect(r.status()).toBe(200);
    const body = await r.json();
    expect(body.idempotent).toBe(true);
  });
});

// =====================================================================
// Acceptance #276 — Reject button writes status=REJECTED and emits an
// AuditLog row.
// =====================================================================

test.describe('Orchestrator API — reject emits audit (#276)', () => {
  test('reject flips status to "rejected" + sets resolvedById/resolvedAt', async ({ request }) => {
    const { rows } = await runAndList(request);
    const target = rows.find((r) => r.status === 'pending');
    if (!target) test.skip(true, 'no pending row');
    const r = await authPost(request, `/api/wellness/recommendations/${target.id}/reject`, { reason: `${RUN_TAG} #276` });
    expect(r.status()).toBe(200);
    const body = await r.json();
    expect(body.status).toBe('rejected');
    expect(typeof body.resolvedById).toBe('number');
    expect(body.resolvedAt).toBeTruthy();
    surfacedRecIds.delete(target.id);
  });

  test('reject writes an AuditLog row with action=REJECT + entity=AgentRecommendation (#276, #179)', async ({ request }) => {
    const { rows } = await runAndList(request);
    const target = rows.find((r) => r.status === 'pending');
    if (!target) test.skip(true, 'no pending row');
    const reason = `${RUN_TAG} reason-for-audit`;
    const rej = await authPost(request, `/api/wellness/recommendations/${target.id}/reject`, { reason });
    expect(rej.status()).toBe(200);
    surfacedRecIds.delete(target.id);

    // Audit log shows up in the audit-viewer (admin-only)
    const av = await authGet(request, `/api/audit-viewer?entity=AgentRecommendation&action=REJECT&limit=50`);
    expect(av.status(), `audit-viewer: ${await av.text()}`).toBe(200);
    const { logs } = await av.json();
    const row = logs.find((l) => l.entityId === target.id);
    expect(row, `expected an AuditLog row for AgentRecommendation id=${target.id}`).toBeTruthy();
    expect(row.action).toBe('REJECT');
    expect(row.entity).toBe('AgentRecommendation');
    // Audit blob shape (NOT full payload — only safe fields per CLAUDE.md
    // standing rule: title + priority + reason are operationally useful
    // and PII-free).
    const details = JSON.parse(row.details || '{}');
    expect(details.title, 'audit blob should carry the card title').toBeTruthy();
    expect(details.reason, 'audit blob should echo the rejection reason').toBe(reason);
    // Defence-in-depth: blob MUST NOT contain credential / hash / PHI
    // field NAMES that the writeAudit caller didn't include.
    expect(details).not.toHaveProperty('payload');
    expect(details).not.toHaveProperty('passwordHash');
    expect(details).not.toHaveProperty('portalPasswordHash');
  });

  test('approve writes an AuditLog row with action=APPROVE (#179)', async ({ request }) => {
    const { rows } = await runAndList(request);
    const target = rows.find((r) => r.status === 'pending');
    if (!target) test.skip(true, 'no pending row');
    const ap = await authPost(request, `/api/wellness/recommendations/${target.id}/approve`, {});
    expect(ap.status()).toBe(200);
    surfacedRecIds.delete(target.id);

    const av = await authGet(request, `/api/audit-viewer?entity=AgentRecommendation&action=APPROVE&limit=50`);
    expect(av.status()).toBe(200);
    const { logs } = await av.json();
    const row = logs.find((l) => l.entityId === target.id);
    expect(row, `expected APPROVE AuditLog row for id=${target.id}`).toBeTruthy();
    const details = JSON.parse(row.details || '{}');
    expect(details).toHaveProperty('title');
    expect(details).toHaveProperty('priority');
    expect(details).toHaveProperty('dispatched');
  });

  test('idempotent re-reject does NOT write a duplicate audit row (#276 belt-and-braces)', async ({ request }) => {
    const { rows } = await runAndList(request);
    const target = rows.find((r) => r.status === 'pending');
    if (!target) test.skip(true, 'no pending row');
    // First reject
    const rej1 = await authPost(request, `/api/wellness/recommendations/${target.id}/reject`, { reason: `${RUN_TAG} first` });
    expect(rej1.status()).toBe(200);
    surfacedRecIds.delete(target.id);
    const before = await authGet(request, `/api/audit-viewer?entity=AgentRecommendation&action=REJECT&limit=200`);
    const beforeCount = (await before.json()).logs.filter((l) => l.entityId === target.id).length;
    // Second reject (idempotent path — the route returns idempotent:true
    // and MUST NOT write another audit row).
    const rej2 = await authPost(request, `/api/wellness/recommendations/${target.id}/reject`, { reason: `${RUN_TAG} second` });
    expect(rej2.status()).toBe(200);
    expect((await rej2.json()).idempotent).toBe(true);
    const after = await authGet(request, `/api/audit-viewer?entity=AgentRecommendation&action=REJECT&limit=200`);
    const afterCount = (await after.json()).logs.filter((l) => l.entityId === target.id).length;
    expect(afterCount, 'idempotent reject should NOT emit a new audit row').toBe(beforeCount);
  });
});

// =====================================================================
// Acceptance #319 — Generated text never contains seed-pollution
// patterns (`Lifecycle \\d+`, `E2E_`, `Tenant B scoped`).
// =====================================================================

test.describe('Orchestrator API — generated text is pollution-free (#319)', () => {
  // Seed-pollution patterns we MUST never see leak into a card. These
  // mirror the regexes in e2e/test-data-patterns.js — the orchestrator
  // reads real Visit / Contact / Service / Location rows; if a previous
  // test leaked a fixture into one of those tables and it survived a
  // teardown gap, the next /orchestrator/run could embed the marker
  // into a card title/body.
  const POLLUTION_PATTERNS = [
    /\bLifecycle \d+\b/,
    /E2E_/,
    /\bTenant B scoped\b/,
    // NOTE: `_teardown_` was previously listed here as a "defence-in-depth"
    // sentinel, but it's actually the rename marker the wellness-dashboard-api
    // afterAll uses to soft-clean its touched recommendations (sets
    // title=`_teardown_dashboard_<id>` and goalContext=`_teardown_dashboard`).
    // Flagging it as pollution made this test contradict the cleanup tag.
    // Removed 2026-05-08 — `_teardown_` is intentional cleanup state, not pollution.
  ];

  function scanRow(row) {
    const blob = JSON.stringify({
      title: row.title || '',
      body: row.body || '',
      expectedImpact: row.expectedImpact || '',
      goalContext: row.goalContext || '',
      // payload may carry serviceName / suggestedDailyBudget / leadIds
      payload: row.payload || '',
    });
    for (const re of POLLUTION_PATTERNS) {
      const m = blob.match(re);
      if (m) {
        return { matched: re.toString(), excerpt: blob.substring(Math.max(0, blob.indexOf(m[0]) - 30), blob.indexOf(m[0]) + 60) };
      }
    }
    return null;
  }

  test('current /recommendations rows carry no pollution markers (#319)', async ({ request }) => {
    // Demo accumulates pre-existing pollution from prior test runs (e.g.
    // wellness-dashboard-api shipped a row titled
    // `E2E_FLOW_DASHBOARD_..._amended_title_280` before its afterAll
    // soft-rename could complete on a previous interrupted run). That
    // surfaces in this scan as a false positive — the orchestrator code
    // is fine; the demo DB has accumulated stale rows. The two follow-up
    // tests below (`after a fresh /orchestrator/run` + `contextSummary
    // is pollution-free`) ARE correctly scoped to freshly-generated
    // content and stay enabled cross-machine. The scrub-test-data-pollution
    // script's scrubAgentRecommendations() pass clears these on every
    // post-tag run, so this assertion is durable on a clean baseline only.
    test.skip(!IS_LOCAL_STACK, 'skips against demo: scans aggregate state which accumulates prior-test pollution between scrubs (#319 fresh-run scope is covered by the next two tests)');
    const all = await listAllRecs(request);
    const offenders = [];
    for (const row of all) {
      const hit = scanRow(row);
      if (hit) offenders.push({ id: row.id, ...hit });
    }
    expect(offenders, `pollution leaked into recommendation cards: ${JSON.stringify(offenders)}`).toEqual([]);
  });

  test('after a fresh /orchestrator/run new rows carry no pollution markers (#319)', async ({ request }) => {
    // Demo accumulates pre-existing pollution from prior test runs (rows
    // titled `E2E_FLOW_DASHBOARD_..._amended_title_<id>` from
    // wellness-dashboard-api's interrupted teardown, plus seed visits whose
    // contact names contain `Lifecycle 538350`-style markers). Those rows
    // existed BEFORE this test ran — they're not generated by the fresh
    // /orchestrator/run we're about to trigger. Scope the assertion to ONLY
    // the rows added by this run by capturing pre-run ids first, then
    // diffing post-run. The contract under test (#319) is "the
    // orchestrator's NEW output is pollution-free", not "every historical
    // row in the table is clean" — that's covered by the test above which
    // already test.skip's against demo for this exact reason.
    const before = await listAllRecs(request);
    const beforeIds = new Set(before.map((r) => r.id));
    const { rows } = await runAndList(request);
    const freshRows = rows.filter((r) => !beforeIds.has(r.id));
    const offenders = [];
    for (const row of freshRows) {
      const hit = scanRow(row);
      if (hit) offenders.push({ id: row.id, ...hit });
    }
    expect(
      offenders,
      `pollution leaked from a fresh run (scoped to rows created by this run only — ${freshRows.length} new of ${rows.length} total): ${JSON.stringify(offenders)}`
    ).toEqual([]);
  });

  test('orchestrator contextSummary is pollution-free (#319)', async ({ request }) => {
    const r = await authPost(request, '/api/wellness/orchestrator/run', {});
    const body = await r.json();
    for (const re of POLLUTION_PATTERNS) {
      expect(body.contextSummary, `contextSummary leaked pollution matching ${re}: ${body.contextSummary}`).not.toMatch(re);
    }
  });
});

// =====================================================================
// Acceptance #321 — Cost arithmetic doesn't overflow. Totals < 1e10 ₹.
// =====================================================================

test.describe('Orchestrator API — cost arithmetic stays in bounds (#321)', () => {
  // 1e10 = ₹1000 crore — ANY single-clinic week revenue or recommendation
  // budget exceeding this is a math overflow / unit error, not real demand.
  const OVERFLOW_THRESHOLD = 1e10;

  // Pick out every numeric field anywhere inside an object/array.
  function* eachNumber(obj, path = '') {
    if (obj === null || obj === undefined) return;
    if (typeof obj === 'number') {
      yield { path, value: obj };
      return;
    }
    if (typeof obj === 'object') {
      for (const k of Object.keys(obj)) {
        yield* eachNumber(obj[k], path ? `${path}.${k}` : k);
      }
    }
  }

  test('every numeric field on a recommendation row stays under 1e10 (#321)', async ({ request }) => {
    await authPost(request, '/api/wellness/orchestrator/run', {});
    const all = await listAllRecs(request);
    const offenders = [];
    for (const row of all) {
      for (const hit of eachNumber(row)) {
        if (hit.value > OVERFLOW_THRESHOLD) {
          offenders.push({ id: row.id, ...hit });
        }
        // NaN is not > anything; flag it explicitly.
        if (typeof hit.value === 'number' && Number.isNaN(hit.value)) {
          offenders.push({ id: row.id, path: hit.path, value: 'NaN' });
        }
      }
    }
    expect(offenders, `numeric overflow / NaN in card row: ${JSON.stringify(offenders)}`).toEqual([]);
  });

  test('payload.suggestedDailyBudget (when present) stays in [300, 2000] ₹ band (#321)', async ({ request }) => {
    const all = await listAllRecs(request);
    for (const row of all) {
      if (!row.payload) continue;
      let payload;
      try { payload = JSON.parse(row.payload); } catch { continue; }
      if (typeof payload.suggestedDailyBudget !== 'number') continue;
      // Engine bounds: Math.min(2000, Math.max(300, …)) — anything outside
      // is a regression in the cost model.
      expect(payload.suggestedDailyBudget, `id=${row.id} budget=${payload.suggestedDailyBudget} out of band`).toBeGreaterThanOrEqual(300);
      expect(payload.suggestedDailyBudget).toBeLessThanOrEqual(2000);
    }
  });

  test('expectedImpact strings carry currency-shaped numbers under 1e10 ₹ (#321)', async ({ request }) => {
    const all = await listAllRecs(request);
    // Match an Indian-style ₹X,Y,Z or ₹XX,XX,XXX number. We extract every
    // such number from the expectedImpact string and bound-check.
    const RUPEE_RE = /₹([\d,]+)/g;
    for (const row of all) {
      const text = `${row.expectedImpact || ''} ${row.body || ''}`;
      let m;
      while ((m = RUPEE_RE.exec(text)) !== null) {
        const n = parseInt(m[1].replace(/,/g, ''), 10);
        if (Number.isFinite(n)) {
          expect(n, `id=${row.id} rupee figure ${m[0]} parsed to ${n} which exceeds ₹100 cr`).toBeLessThan(OVERFLOW_THRESHOLD);
          expect(n).toBeGreaterThanOrEqual(0);
        }
      }
    }
  });

  test('contextSummary week-revenue figure stays under 1e10 ₹ (#321)', async ({ request }) => {
    const r = await authPost(request, '/api/wellness/orchestrator/run', {});
    const { contextSummary } = await r.json();
    const m = contextSummary.match(/week revenue ₹([\d,]+)/i);
    if (m) {
      const n = parseInt(m[1].replace(/,/g, ''), 10);
      expect(n).toBeLessThan(OVERFLOW_THRESHOLD);
    }
  });
});

// =====================================================================
// Auth gates + RBAC (defence-in-depth — manual-trigger endpoint must be
// ADMIN/MANAGER only per #216)
// =====================================================================

test.describe('Orchestrator API — auth + RBAC gates (#216)', () => {
  test('POST /orchestrator/run without token → 401/403', async ({ request }) => {
    const r = await request.post(`${API}/wellness/orchestrator/run`, { data: {} });
    expect([401, 403]).toContain(r.status());
  });

  test('POST /orchestrator/run as wellness USER+doctor → 403 WELLNESS_ROLE_FORBIDDEN', async ({ request }) => {
    const r = await authPost(request, '/api/wellness/orchestrator/run', {}, 'doctor');
    expect(r.status()).toBe(403);
    const body = await r.json();
    expect(body.code).toBe('WELLNESS_ROLE_FORBIDDEN');
  });

  test('POST /orchestrator/run as generic-tenant ADMIN → 403 WELLNESS_TENANT_REQUIRED (#325)', async ({ request }) => {
    const r = await authPost(request, '/api/wellness/orchestrator/run', {}, 'genericAdmin');
    expect(r.status()).toBe(403);
    const body = await r.json();
    expect(body.code).toBe('WELLNESS_TENANT_REQUIRED');
  });

  test('POST /recommendations/:id/reject as doctor → 403 WELLNESS_ROLE_FORBIDDEN', async ({ request }) => {
    // Use a stable seeded id (or any pending row) — the gate triggers
    // BEFORE the row lookup, so the id only needs to be numeric.
    const r = await authPost(request, '/api/wellness/recommendations/99999999/reject', { reason: 'doctor-attempt' }, 'doctor');
    expect(r.status()).toBe(403);
    expect((await r.json()).code).toBe('WELLNESS_ROLE_FORBIDDEN');
  });

  test('POST /recommendations/:id/approve as doctor → 403 WELLNESS_ROLE_FORBIDDEN', async ({ request }) => {
    const r = await authPost(request, '/api/wellness/recommendations/99999999/approve', {}, 'doctor');
    expect(r.status()).toBe(403);
    expect((await r.json()).code).toBe('WELLNESS_ROLE_FORBIDDEN');
  });

  test('POST /recommendations/:id/reject on unknown id → 404 (after gate passes)', async ({ request }) => {
    const r = await authPost(request, '/api/wellness/recommendations/99999999/reject', { reason: 'nope' });
    expect(r.status()).toBe(404);
  });

  test('POST /recommendations/:id/approve on unknown id → 404', async ({ request }) => {
    const r = await authPost(request, '/api/wellness/recommendations/99999999/approve', {});
    expect(r.status()).toBe(404);
  });

  test('GET /recommendations is tenant-scoped — generic admin sees no wellness rows', async ({ request }) => {
    // Generic tenant has no AgentRecommendation rows by default; assert
    // the tenant-scoped `where` clause stays in effect (the route is NOT
    // gated by verifyWellnessRole on GET — defence-in-depth via tenantWhere).
    const r = await authGet(request, '/api/wellness/recommendations?status=all', 'genericAdmin');
    expect(r.status()).toBe(200);
    const list = await r.json();
    // Every row (if any seeded) must belong to tenantId=1.
    for (const row of list) {
      expect(row.tenantId, `cross-tenant leak: row id=${row.id} carries tenantId=${row.tenantId} for generic admin`).toBe(1);
    }
  });
});
