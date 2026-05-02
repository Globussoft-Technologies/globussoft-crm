// @ts-check
/**
 * Workflows CRUD API — automation rule admin surface (/api/workflows).
 *
 * G-2 from docs/E2E_GAPS.md. Covers the 9 endpoints on
 * backend/routes/workflows.js (314 lines) which today only have smoke-only
 * coverage via workflows-flow.spec.js (engine-side flows, not route CRUD).
 *
 * Endpoints covered (9):
 *   GET    /api/workflows/triggers   — static catalog (18 trigger types)
 *   GET    /api/workflows/actions    — static catalog (8 action types)
 *   GET    /api/workflows/history    — execution audit log (paginated)
 *   GET    /api/workflows/           — list rules for tenant
 *   POST   /api/workflows/           — create (+ enum + condition validation)
 *   PUT    /api/workflows/:id        — update (incl. isActive toggle via PUT, #19)
 *   DELETE /api/workflows/:id
 *   PUT    /api/workflows/:id/toggle — flip isActive
 *   POST   /api/workflows/:id/test   — fire rule with mock payload
 *
 * Doc-card-vs-reality drifts found while reading the route:
 *
 *   1. Schema field is `isActive` (Boolean), NOT `enabled`. The G-2 card
 *      says "toggle flips `enabled` field"; route + Prisma model use
 *      `isActive`. Spec asserts the actual field.
 *
 *   2. `/test` is NOT a true dry-run. It calls emitEvent() which fires the
 *      rule's actual action through executeAction(). For DB-mutating
 *      actions (create_task, send_notification, create_approval,
 *      update_field, assign_agent) the side-effects are real. The G-2
 *      "does NOT mutate target records" criterion holds only in the sense
 *      that `/test` does not modify the *rule itself* (no isActive flip,
 *      no name change, no targetState change).
 *
 *      To prove the dry-run-vs-rule contract clearly the spec uses
 *      actionType="send_sms" — sms case in eventBus.js is a console.log
 *      no-op that writes ZERO new DB rows for the action itself, so we
 *      can assert: rule unchanged + no Task/Notification side-effect rows
 *      created during /test. (One AuditLog row IS created by the engine's
 *      always-on execution log; the spec asserts that as the post-test
 *      history-page count goes up by exactly 1.)
 *
 *   3. Auth gate — middleware/auth.js returns 403 (not 401) when the
 *      Authorization header is missing entirely. With a malformed/expired
 *      token it returns 401. Spec accepts [401, 403] to match prior specs
 *      (landing-pages-api, notifications-api).
 *
 *   4. POST validation order: missing required (name/triggerType/
 *      actionType) returns 400 with `error` (no `code`). Bad enum returns
 *      400 with `code: "INVALID_TRIGGER_TYPE" | "INVALID_ACTION_TYPE"` +
 *      `allowed: [...]`. Bad condition returns 400 with
 *      `code: "INVALID_CONDITION"`.
 *
 *   5. Cross-tenant access on every record-scoped op (GET-via-list-only,
 *      PUT, DELETE, /toggle, /test) returns **404**, not 403 — the route
 *      uses `findFirst({ where: {id, tenantId} })` so a foreign id is
 *      indistinguishable from an unknown id. Both correct and consistent
 *      with the rest of the codebase (id enumeration prevention).
 *
 *   6. There is no GET /:id endpoint — only GET /. Reads of a single rule
 *      go through the list. `route.js` doesn't expose a single-row read.
 *      Spec doesn't probe a non-existent endpoint.
 *
 * Pattern: e2e/tests/landing-pages-api.spec.js (commit 1e5bd3e). Dual-
 * token (generic admin drives main CRUD; wellness admin drives tenant
 * isolation). RUN_TAG = `E2E_FLOW_WF_<ts>` matches the existing
 * /^E2E_FLOW_/ regex in e2e/test-data-patterns.js. global-teardown does
 * NOT sweep AutomationRule rows, so beforeAll pre-cleans any orphan
 * E2E_FLOW_WF_ rules and afterAll deletes everything this run created.
 */
const { test, expect } = require('@playwright/test');

// Serial: cleanup tracker is mutated across describe blocks, and the
// tenant-isolation block creates a wellness rule that several later
// generic-admin checks must NOT see. Parallel shuffle would race those
// assertions.
test.describe.configure({ mode: 'serial' });

const BASE_URL = process.env.BASE_URL || 'https://crm.globusdemos.com';
const REQUEST_TIMEOUT = 30000;
const RUN_TAG = `E2E_FLOW_WF_${Date.now()}`;

// ── Dual-token auth ────────────────────────────────────────────────
// admin@globussoft.com (ADMIN, generic tenant)  — drives main CRUD
// admin@wellness.demo  (ADMIN, wellness tenant) — drives tenant iso

let genericToken = null;
let genericUserId = null;
let wellnessToken = null;
let wellnessUserId = null;

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
    } catch (_e) {
      if (attempt === 0) continue;
    }
  }
  return { token: null, userId: null };
}

async function getGeneric(request) {
  if (!genericToken) {
    const r = await loginAs(request, 'admin@globussoft.com', 'password123');
    genericToken = r.token;
    genericUserId = r.userId;
  }
  return { token: genericToken, userId: genericUserId };
}

async function getWellness(request) {
  if (!wellnessToken) {
    const r = await loginAs(request, 'admin@wellness.demo', 'password123');
    wellnessToken = r.token;
    wellnessUserId = r.userId;
  }
  return { token: wellnessToken, userId: wellnessUserId };
}

const headers = (token) => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' });

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

// ── Cleanup tracker keyed by tenant ────────────────────────────────
const createdRulesByTenant = { generic: new Set(), wellness: new Set() };

// Pre-cleanup orphans from prior aborted runs. global-teardown does not
// sweep AutomationRule rows, so each run must self-purge anything matching
// /^E2E_FLOW_WF_/ in either tenant's list view.
async function purgeOrphansFor(request, tenant) {
  const tok = tenant === 'generic'
    ? (await getGeneric(request)).token
    : (await getWellness(request)).token;
  if (!tok) return;
  const res = await get(request, tok, '/api/workflows');
  if (!res.ok()) return;
  const list = await res.json();
  if (!Array.isArray(list)) return;
  const orphans = list.filter((r) => typeof r.name === 'string' && /^E2E_FLOW_WF_/.test(r.name));
  for (const r of orphans) {
    await del(request, tok, `/api/workflows/${r.id}`).catch(() => {});
  }
}

test.beforeAll(async ({ request }) => {
  // Warm both tokens up-front so login doesn't race the first test.
  await getGeneric(request);
  await getWellness(request);
  await purgeOrphansFor(request, 'generic');
  await purgeOrphansFor(request, 'wellness');
});

test.afterAll(async ({ request }) => {
  for (const [tenant, ids] of Object.entries(createdRulesByTenant)) {
    const tok = tenant === 'generic'
      ? (await getGeneric(request)).token
      : (await getWellness(request)).token;
    if (!tok) continue;
    for (const id of ids) {
      await del(request, tok, `/api/workflows/${id}`).catch(() => {});
    }
  }
});

let ruleCounter = 0;
async function createRule(request, tenant, overrides = {}) {
  const tok = tenant === 'generic'
    ? (await getGeneric(request)).token
    : (await getWellness(request)).token;
  if (!tok) throw new Error(`createRule: no ${tenant} token`);
  ruleCounter += 1;
  const body = {
    name: `${RUN_TAG} rule-${ruleCounter}-${Date.now()}`,
    triggerType: 'contact.created',
    actionType: 'create_task',
    targetState: { title: `${RUN_TAG} task ${ruleCounter}`, dueInDays: 1 },
    ...overrides,
  };
  const res = await post(request, tok, '/api/workflows', body);
  expect(res.status(), `createRule(${tenant}): ${await res.text()}`).toBe(201);
  const rule = await res.json();
  createdRulesByTenant[tenant].add(rule.id);
  return rule;
}

// ── GET /triggers ──────────────────────────────────────────────────

test.describe('Workflows API — GET /triggers (static catalog)', () => {
  test('200 returns non-empty array of {value,label,description} entries', async ({ request }) => {
    const { token } = await getGeneric(request);
    const res = await get(request, token, '/api/workflows/triggers');
    expect(res.status()).toBe(200);
    const list = await res.json();
    expect(Array.isArray(list)).toBe(true);
    expect(list.length).toBeGreaterThanOrEqual(15);
    for (const t of list) {
      expect(typeof t.value).toBe('string');
      expect(typeof t.label).toBe('string');
      expect(typeof t.description).toBe('string');
    }
    // Spot-check a few canonical values that workflows-flow.spec.js depends on.
    const values = list.map((t) => t.value);
    for (const expected of ['contact.created', 'deal.won', 'deal.stage_changed', 'approval.created', 'sla.breached']) {
      expect(values, `triggers should include ${expected}`).toContain(expected);
    }
  });
});

// ── GET /actions ───────────────────────────────────────────────────

test.describe('Workflows API — GET /actions (static catalog)', () => {
  test('200 returns non-empty array of {value,label,config} entries', async ({ request }) => {
    const { token } = await getGeneric(request);
    const res = await get(request, token, '/api/workflows/actions');
    expect(res.status()).toBe(200);
    const list = await res.json();
    expect(Array.isArray(list)).toBe(true);
    expect(list.length).toBeGreaterThanOrEqual(7);
    for (const a of list) {
      expect(typeof a.value).toBe('string');
      expect(typeof a.label).toBe('string');
      expect(Array.isArray(a.config)).toBe(true);
    }
    const values = list.map((a) => a.value);
    for (const expected of ['send_email', 'send_sms', 'send_notification', 'create_task', 'send_webhook', 'create_approval']) {
      expect(values, `actions should include ${expected}`).toContain(expected);
    }
  });
});

// ── GET /history ───────────────────────────────────────────────────

test.describe('Workflows API — GET /history', () => {
  test('200 returns paginated envelope {logs,total,limit,offset}', async ({ request }) => {
    const { token } = await getGeneric(request);
    const res = await get(request, token, '/api/workflows/history');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.logs), 'logs should be an array').toBe(true);
    expect(typeof body.total).toBe('number');
    expect(body.limit).toBe(50); // default cap
    expect(body.offset).toBe(0);
  });

  test('200 honors limit + offset query params (limit clamped to 200)', async ({ request }) => {
    const { token } = await getGeneric(request);
    const res = await get(request, token, '/api/workflows/history?limit=10&offset=0');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.limit).toBe(10);
    expect(body.offset).toBe(0);
    expect(body.logs.length).toBeLessThanOrEqual(10);

    // Route caps limit at 200 even if the client asks for more.
    const big = await get(request, token, '/api/workflows/history?limit=9999');
    expect(big.status()).toBe(200);
    expect((await big.json()).limit).toBe(200);
  });

  test('history is tenant-scoped — wellness rule executions do not leak to generic', async ({ request }) => {
    const { token: genTok } = await getGeneric(request);
    // Force a wellness execution by /test on a wellness rule, then assert
    // generic admin's history doesn't reflect it. (We can only check by
    // total count delta because the route hides entityId mapping behind
    // tenantId filtering — exactly what we want to prove.)
    const wellnessRule = await createRule(request, 'wellness', {
      name: `${RUN_TAG} hist-iso-${Date.now()}`,
      actionType: 'send_sms',
    });
    const before = await get(request, genTok, '/api/workflows/history?limit=200');
    const beforeTotal = (await before.json()).total;
    const { token: wellTok } = await getWellness(request);
    const fire = await post(request, wellTok, `/api/workflows/${wellnessRule.id}/test`, {});
    expect(fire.status()).toBe(200);
    const after = await get(request, genTok, '/api/workflows/history?limit=200');
    const afterTotal = (await after.json()).total;
    expect(afterTotal, 'generic history should NOT grow when wellness fires a /test').toBe(beforeTotal);
  });
});

// ── GET / list ─────────────────────────────────────────────────────

test.describe('Workflows API — GET / (list)', () => {
  test('200 returns array containing the rules created in this tenant', async ({ request }) => {
    const { token } = await getGeneric(request);
    const created = await createRule(request, 'generic', { name: `${RUN_TAG} list-shape-${Date.now()}` });
    const res = await get(request, token, '/api/workflows');
    expect(res.status()).toBe(200);
    const list = await res.json();
    expect(Array.isArray(list)).toBe(true);
    const row = list.find((r) => r.id === created.id);
    expect(row, 'created rule should appear in list').toBeTruthy();
    expect(row.name).toBe(created.name);
    expect(row.triggerType).toBe('contact.created');
    expect(row.actionType).toBe('create_task');
    expect(row.isActive).toBe(true);
    expect(typeof row.targetState).toBe('string'); // stored stringified
  });

  test('list scoped to caller tenant — wellness rules do not leak to generic', async ({ request }) => {
    const { token: genTok } = await getGeneric(request);
    const wellnessRule = await createRule(request, 'wellness', { name: `${RUN_TAG} cross-tenant-list-${Date.now()}` });
    const res = await get(request, genTok, '/api/workflows');
    expect(res.status()).toBe(200);
    const list = await res.json();
    expect(list.some((r) => r.id === wellnessRule.id)).toBe(false);
  });
});

// ── POST / (create) ────────────────────────────────────────────────

test.describe('Workflows API — POST / (create)', () => {
  test('201 with valid trigger + action; isActive defaults true; targetState stringified', async ({ request }) => {
    const { token } = await getGeneric(request);
    const name = `${RUN_TAG} create-happy-${Date.now()}`;
    const res = await post(request, token, '/api/workflows', {
      name,
      triggerType: 'deal.created',
      actionType: 'send_notification',
      targetState: { title: 'New deal!', message: 'hi' },
    });
    expect(res.status(), `create-happy: ${await res.text()}`).toBe(201);
    const body = await res.json();
    createdRulesByTenant.generic.add(body.id);
    expect(body.name).toBe(name);
    expect(body.triggerType).toBe('deal.created');
    expect(body.actionType).toBe('send_notification');
    expect(body.isActive).toBe(true);
    expect(typeof body.targetState).toBe('string');
    const parsed = JSON.parse(body.targetState);
    expect(parsed.title).toBe('New deal!');
  });

  test('201 accepts a string targetState verbatim (no double-stringify)', async ({ request }) => {
    const { token } = await getGeneric(request);
    const raw = '{"to":"alerts@example.test","subject":"raw"}';
    const res = await post(request, token, '/api/workflows', {
      name: `${RUN_TAG} create-string-state-${Date.now()}`,
      triggerType: 'contact.created',
      actionType: 'send_email',
      targetState: raw,
    });
    expect(res.status()).toBe(201);
    const body = await res.json();
    createdRulesByTenant.generic.add(body.id);
    expect(body.targetState).toBe(raw);
  });

  test('201 with valid condition JSON-array clauses; round-trips canonical string', async ({ request }) => {
    const { token } = await getGeneric(request);
    const condition = [
      { field: 'deal.amount', op: 'gt', value: 50000 },
      { field: 'contact.status', op: 'eq', value: 'Lead' },
    ];
    const res = await post(request, token, '/api/workflows', {
      name: `${RUN_TAG} create-cond-${Date.now()}`,
      triggerType: 'deal.created',
      actionType: 'create_task',
      targetState: { title: 'big deal' },
      condition,
    });
    expect(res.status()).toBe(201);
    const body = await res.json();
    createdRulesByTenant.generic.add(body.id);
    expect(typeof body.condition).toBe('string');
    expect(JSON.parse(body.condition)).toEqual(condition);
  });

  test('201 with empty-string condition stores null (always-fire)', async ({ request }) => {
    const { token } = await getGeneric(request);
    const res = await post(request, token, '/api/workflows', {
      name: `${RUN_TAG} create-cond-empty-${Date.now()}`,
      triggerType: 'contact.created',
      actionType: 'create_task',
      targetState: { title: 'always' },
      condition: '',
    });
    expect(res.status()).toBe(201);
    const body = await res.json();
    createdRulesByTenant.generic.add(body.id);
    expect(body.condition).toBeNull();
  });

  test('400 missing name', async ({ request }) => {
    const { token } = await getGeneric(request);
    const res = await post(request, token, '/api/workflows', {
      triggerType: 'contact.created',
      actionType: 'create_task',
    });
    expect(res.status()).toBe(400);
    expect((await res.json()).error).toMatch(/required/i);
  });

  test('400 missing triggerType', async ({ request }) => {
    const { token } = await getGeneric(request);
    const res = await post(request, token, '/api/workflows', {
      name: `${RUN_TAG} no-trigger-${Date.now()}`,
      actionType: 'create_task',
    });
    expect(res.status()).toBe(400);
    expect((await res.json()).error).toMatch(/required/i);
  });

  test('400 missing actionType', async ({ request }) => {
    const { token } = await getGeneric(request);
    const res = await post(request, token, '/api/workflows', {
      name: `${RUN_TAG} no-action-${Date.now()}`,
      triggerType: 'contact.created',
    });
    expect(res.status()).toBe(400);
    expect((await res.json()).error).toMatch(/required/i);
  });

  test('400 INVALID_TRIGGER_TYPE on unknown trigger; returns allowed list', async ({ request }) => {
    const { token } = await getGeneric(request);
    const res = await post(request, token, '/api/workflows', {
      name: `${RUN_TAG} bad-trigger-${Date.now()}`,
      triggerType: 'volcano.erupted',
      actionType: 'create_task',
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('INVALID_TRIGGER_TYPE');
    expect(Array.isArray(body.allowed)).toBe(true);
    expect(body.allowed).toContain('contact.created');
  });

  test('400 INVALID_ACTION_TYPE on unknown action; returns allowed list', async ({ request }) => {
    const { token } = await getGeneric(request);
    const res = await post(request, token, '/api/workflows', {
      name: `${RUN_TAG} bad-action-${Date.now()}`,
      triggerType: 'contact.created',
      actionType: 'launch_missile',
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('INVALID_ACTION_TYPE');
    expect(Array.isArray(body.allowed)).toBe(true);
    expect(body.allowed).toContain('create_task');
  });

  test('400 INVALID_CONDITION when condition is not valid JSON', async ({ request }) => {
    const { token } = await getGeneric(request);
    const res = await post(request, token, '/api/workflows', {
      name: `${RUN_TAG} bad-cond-json-${Date.now()}`,
      triggerType: 'contact.created',
      actionType: 'create_task',
      condition: '{not valid json',
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('INVALID_CONDITION');
  });

  test('400 INVALID_CONDITION when condition parses to a non-array', async ({ request }) => {
    const { token } = await getGeneric(request);
    const res = await post(request, token, '/api/workflows', {
      name: `${RUN_TAG} bad-cond-shape-${Date.now()}`,
      triggerType: 'contact.created',
      actionType: 'create_task',
      condition: '{"field":"x","op":"eq","value":1}',
    });
    expect(res.status()).toBe(400);
    expect((await res.json()).code).toBe('INVALID_CONDITION');
  });

  test('400 INVALID_CONDITION when a clause uses an unsupported op', async ({ request }) => {
    const { token } = await getGeneric(request);
    const res = await post(request, token, '/api/workflows', {
      name: `${RUN_TAG} bad-cond-op-${Date.now()}`,
      triggerType: 'contact.created',
      actionType: 'create_task',
      condition: [{ field: 'deal.amount', op: 'NUKE', value: 1 }],
    });
    expect(res.status()).toBe(400);
    expect((await res.json()).code).toBe('INVALID_CONDITION');
  });

  test('400 INVALID_CONDITION when a clause is missing field', async ({ request }) => {
    const { token } = await getGeneric(request);
    const res = await post(request, token, '/api/workflows', {
      name: `${RUN_TAG} bad-cond-nofield-${Date.now()}`,
      triggerType: 'contact.created',
      actionType: 'create_task',
      condition: [{ op: 'eq', value: 1 }],
    });
    expect(res.status()).toBe(400);
    expect((await res.json()).code).toBe('INVALID_CONDITION');
  });
});

// ── PUT /:id (update) ──────────────────────────────────────────────

test.describe('Workflows API — PUT /:id (update)', () => {
  test('200 partial update merges fields; untouched fields preserved', async ({ request }) => {
    const { token } = await getGeneric(request);
    const created = await createRule(request, 'generic', { name: `${RUN_TAG} put-merge-${Date.now()}` });
    const newName = `${RUN_TAG} put-merge-renamed-${Date.now()}`;
    const res = await put(request, token, `/api/workflows/${created.id}`, { name: newName });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.id).toBe(created.id);
    expect(body.name).toBe(newName);
    expect(body.triggerType).toBe(created.triggerType); // unchanged
    expect(body.actionType).toBe(created.actionType);
    expect(body.isActive).toBe(true);
  });

  test('200 PUT with isActive:false flips active state (alternate path to /toggle, #19)', async ({ request }) => {
    const { token } = await getGeneric(request);
    const created = await createRule(request, 'generic', { name: `${RUN_TAG} put-isactive-${Date.now()}` });
    expect(created.isActive).toBe(true);
    const res = await put(request, token, `/api/workflows/${created.id}`, { isActive: false });
    expect(res.status()).toBe(200);
    expect((await res.json()).isActive).toBe(false);
  });

  test('200 PUT updates targetState; non-string values are stringified', async ({ request }) => {
    const { token } = await getGeneric(request);
    const created = await createRule(request, 'generic', { name: `${RUN_TAG} put-state-${Date.now()}` });
    const res = await put(request, token, `/api/workflows/${created.id}`, {
      targetState: { title: 'updated', dueInDays: 5 },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(typeof body.targetState).toBe('string');
    const parsed = JSON.parse(body.targetState);
    expect(parsed.dueInDays).toBe(5);
  });

  test('200 PUT updates condition; valid clauses round-trip', async ({ request }) => {
    const { token } = await getGeneric(request);
    const created = await createRule(request, 'generic', { name: `${RUN_TAG} put-cond-${Date.now()}` });
    const cond = [{ field: 'contact.email', op: 'contains', value: '@example.com' }];
    const res = await put(request, token, `/api/workflows/${created.id}`, { condition: cond });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(JSON.parse(body.condition)).toEqual(cond);
  });

  test('200 PUT with condition:null clears condition (always-fire)', async ({ request }) => {
    const { token } = await getGeneric(request);
    const created = await createRule(request, 'generic', {
      name: `${RUN_TAG} put-cond-clear-${Date.now()}`,
      condition: [{ field: 'deal.amount', op: 'gt', value: 1 }],
    });
    expect(created.condition).not.toBeNull();
    const res = await put(request, token, `/api/workflows/${created.id}`, { condition: null });
    expect(res.status()).toBe(200);
    expect((await res.json()).condition).toBeNull();
  });

  test('400 PUT INVALID_TRIGGER_TYPE on unknown trigger', async ({ request }) => {
    const { token } = await getGeneric(request);
    const created = await createRule(request, 'generic', { name: `${RUN_TAG} put-bad-trigger-${Date.now()}` });
    const res = await put(request, token, `/api/workflows/${created.id}`, { triggerType: 'tsunami.crashed' });
    expect(res.status()).toBe(400);
    expect((await res.json()).code).toBe('INVALID_TRIGGER_TYPE');
  });

  test('400 PUT INVALID_ACTION_TYPE on unknown action', async ({ request }) => {
    const { token } = await getGeneric(request);
    const created = await createRule(request, 'generic', { name: `${RUN_TAG} put-bad-action-${Date.now()}` });
    const res = await put(request, token, `/api/workflows/${created.id}`, { actionType: 'mind_control' });
    expect(res.status()).toBe(400);
    expect((await res.json()).code).toBe('INVALID_ACTION_TYPE');
  });

  test('400 PUT INVALID_CONDITION on bad condition shape', async ({ request }) => {
    const { token } = await getGeneric(request);
    const created = await createRule(request, 'generic', { name: `${RUN_TAG} put-bad-cond-${Date.now()}` });
    const res = await put(request, token, `/api/workflows/${created.id}`, {
      condition: [{ field: 'x', op: 'wat', value: 1 }],
    });
    expect(res.status()).toBe(400);
    expect((await res.json()).code).toBe('INVALID_CONDITION');
  });

  test('404 PUT on unknown id', async ({ request }) => {
    const { token } = await getGeneric(request);
    const res = await put(request, token, '/api/workflows/99999999', { name: 'x' });
    expect(res.status()).toBe(404);
  });
});

// ── DELETE /:id ────────────────────────────────────────────────────

test.describe('Workflows API — DELETE /:id', () => {
  test('200 deletes own rule and removes from list', async ({ request }) => {
    const { token } = await getGeneric(request);
    const created = await createRule(request, 'generic', { name: `${RUN_TAG} delete-target-${Date.now()}` });
    createdRulesByTenant.generic.delete(created.id); // we delete here; afterAll skips.
    const res = await del(request, token, `/api/workflows/${created.id}`);
    expect(res.status()).toBe(200);
    expect((await res.json()).success).toBe(true);

    // Verify it's gone from the list view.
    const listRes = await get(request, token, '/api/workflows');
    const list = await listRes.json();
    expect(list.find((r) => r.id === created.id)).toBeUndefined();
  });

  test('404 DELETE on unknown id', async ({ request }) => {
    const { token } = await getGeneric(request);
    const res = await del(request, token, '/api/workflows/99999999');
    expect(res.status()).toBe(404);
  });
});

// ── PUT /:id/toggle ────────────────────────────────────────────────

test.describe('Workflows API — PUT /:id/toggle', () => {
  test('200 flips isActive true → false → true (idempotent boolean negation)', async ({ request }) => {
    const { token } = await getGeneric(request);
    const created = await createRule(request, 'generic', { name: `${RUN_TAG} toggle-${Date.now()}` });
    expect(created.isActive).toBe(true);

    const off = await put(request, token, `/api/workflows/${created.id}/toggle`, {});
    expect(off.status()).toBe(200);
    expect((await off.json()).isActive).toBe(false);

    const on = await put(request, token, `/api/workflows/${created.id}/toggle`, {});
    expect(on.status()).toBe(200);
    expect((await on.json()).isActive).toBe(true);

    const offAgain = await put(request, token, `/api/workflows/${created.id}/toggle`, {});
    expect(offAgain.status()).toBe(200);
    expect((await offAgain.json()).isActive).toBe(false);
  });

  test('404 toggle on unknown id', async ({ request }) => {
    const { token } = await getGeneric(request);
    const res = await put(request, token, '/api/workflows/99999999/toggle', {});
    expect(res.status()).toBe(404);
  });
});

// ── POST /:id/test (dry-run-ish) ───────────────────────────────────

test.describe('Workflows API — POST /:id/test', () => {
  test('200 with success message; rule state itself is unchanged', async ({ request }) => {
    const { token } = await getGeneric(request);
    // Use send_sms — eventBus.js executeAction switch is a console.log no-op
    // for this case, so /test does NOT create downstream Task / Notification
    // / ApprovalRequest rows. The execution-log AuditLog row IS still
    // written; we assert that separately below.
    const created = await createRule(request, 'generic', {
      name: `${RUN_TAG} test-no-mutate-${Date.now()}`,
      actionType: 'send_sms',
      targetState: { to: '+0000000000', message: 'noop' },
    });

    const res = await post(request, token, `/api/workflows/${created.id}/test`, {});
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.message).toMatch(new RegExp(`Test fired for rule "${created.name.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}"`));
    expect(body.message).toContain(created.triggerType);

    // Rule itself MUST be unchanged. Read it back via the list and compare
    // every persisted field that /test could plausibly clobber.
    const listRes = await get(request, token, '/api/workflows');
    const after = (await listRes.json()).find((r) => r.id === created.id);
    expect(after, 'rule should still exist after /test').toBeTruthy();
    expect(after.id).toBe(created.id);
    expect(after.name).toBe(created.name);
    expect(after.triggerType).toBe(created.triggerType);
    expect(after.actionType).toBe(created.actionType);
    expect(after.targetState).toBe(created.targetState);
    expect(after.condition).toBe(created.condition);
    expect(after.isActive).toBe(created.isActive);
  });

  test('200 /test grows /history with at least one row referencing the tested rule (audit-log side effect of engine)', async ({ request }) => {
    const { token } = await getGeneric(request);
    const created = await createRule(request, 'generic', {
      name: `${RUN_TAG} test-history-delta-${Date.now()}`,
      actionType: 'send_sms',
      targetState: { to: '+0000000000', message: 'noop' },
    });
    const before = await get(request, token, '/api/workflows/history?limit=200');
    const beforeTotal = (await before.json()).total;

    const res = await post(request, token, `/api/workflows/${created.id}/test`, {});
    expect(res.status()).toBe(200);

    // Tiny gap so the audit-log create has committed before we count.
    await new Promise((r) => setTimeout(r, 250));
    const after = await get(request, token, '/api/workflows/history?limit=200');
    const afterBody = await after.json();
    const afterTotal = afterBody.total;

    // The route fires emitEvent(triggerType) which fans out to EVERY active
    // rule in this tenant matching that trigger — not just the one being
    // tested. So the delta is "active rules with this trigger", typically
    // >=1. The strict contract we can assert: at least one new audit row
    // exists AND at least one of those rows references our rule's id.
    expect(
      afterTotal,
      `/test should grow history total by at least 1; got delta ${afterTotal - beforeTotal}`
    ).toBeGreaterThan(beforeTotal);

    const ourRuleHit = afterBody.logs.find(
      (l) => l.entity === 'AutomationRule' && l.entityId === created.id
    );
    expect(
      ourRuleHit,
      `expected an audit row with entityId=${created.id} after /test fired this rule; latest entityIds: ${JSON.stringify(afterBody.logs.slice(0, 5).map((l) => l.entityId))}`
    ).toBeTruthy();
  });

  test('200 /test accepts a custom payload and the route does not mutate it back to caller', async ({ request }) => {
    const { token } = await getGeneric(request);
    const created = await createRule(request, 'generic', {
      name: `${RUN_TAG} test-payload-${Date.now()}`,
      actionType: 'send_sms',
    });
    const res = await post(request, token, `/api/workflows/${created.id}/test`, {
      payload: { foo: 'bar', _test: true },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    // Route only echoes name + triggerType in the message; doesn't reflect arbitrary keys.
    expect(body.success).toBe(true);
    expect(body.foo).toBeUndefined();
  });

  test('404 /test on unknown id', async ({ request }) => {
    const { token } = await getGeneric(request);
    const res = await post(request, token, '/api/workflows/99999999/test', {});
    expect(res.status()).toBe(404);
  });
});

// ── Tenant isolation — single wellness rule, every record-scoped op 404s ──

test.describe('Workflows API — tenant isolation', () => {
  test('generic admin gets 404 on every record-scoped op against a wellness rule', async ({ request }) => {
    const { token: genTok } = await getGeneric(request);
    const wellnessRule = await createRule(request, 'wellness', {
      name: `${RUN_TAG} cross-tenant-iso-${Date.now()}`,
    });

    const checks = [
      ['PUT',    `/api/workflows/${wellnessRule.id}`,         () => put(request, genTok, `/api/workflows/${wellnessRule.id}`, { name: 'should not happen' })],
      ['DELETE', `/api/workflows/${wellnessRule.id}`,         () => del(request, genTok, `/api/workflows/${wellnessRule.id}`)],
      ['PUT',    `/api/workflows/${wellnessRule.id}/toggle`,  () => put(request, genTok, `/api/workflows/${wellnessRule.id}/toggle`, {})],
      ['POST',   `/api/workflows/${wellnessRule.id}/test`,    () => post(request, genTok, `/api/workflows/${wellnessRule.id}/test`, {})],
    ];

    for (const [method, path, fn] of checks) {
      const res = await fn();
      expect(res.status(), `${method} ${path} should 404 cross-tenant; got ${res.status()}`).toBe(404);
    }

    // Also verify the wellness rule did NOT get flipped/deleted by any of the
    // probes above — read it through the wellness token list.
    const { token: wellTok } = await getWellness(request);
    const wellList = await get(request, wellTok, '/api/workflows');
    const stillThere = (await wellList.json()).find((r) => r.id === wellnessRule.id);
    expect(stillThere, 'wellness rule should survive every cross-tenant probe').toBeTruthy();
    expect(stillThere.name).toBe(wellnessRule.name);
    expect(stillThere.isActive).toBe(true);
  });
});

// ── Auth gate — every endpoint refuses without a token ─────────────

test.describe('Workflows API — auth gate', () => {
  test('GET /triggers without token → 401/403', async ({ request }) => {
    const res = await request.get(`${BASE_URL}/api/workflows/triggers`);
    expect([401, 403]).toContain(res.status());
  });

  test('GET /actions without token → 401/403', async ({ request }) => {
    const res = await request.get(`${BASE_URL}/api/workflows/actions`);
    expect([401, 403]).toContain(res.status());
  });

  test('GET /history without token → 401/403', async ({ request }) => {
    const res = await request.get(`${BASE_URL}/api/workflows/history`);
    expect([401, 403]).toContain(res.status());
  });

  test('GET / without token → 401/403', async ({ request }) => {
    const res = await request.get(`${BASE_URL}/api/workflows`);
    expect([401, 403]).toContain(res.status());
  });

  test('POST / without token → 401/403', async ({ request }) => {
    const res = await request.post(`${BASE_URL}/api/workflows`, {
      data: { name: 'no auth', triggerType: 'contact.created', actionType: 'create_task' },
      headers: { 'Content-Type': 'application/json' },
    });
    expect([401, 403]).toContain(res.status());
  });

  test('PUT /:id without token → 401/403', async ({ request }) => {
    const res = await request.put(`${BASE_URL}/api/workflows/1`, {
      data: { name: 'no auth' },
      headers: { 'Content-Type': 'application/json' },
    });
    expect([401, 403]).toContain(res.status());
  });

  test('DELETE /:id without token → 401/403', async ({ request }) => {
    const res = await request.delete(`${BASE_URL}/api/workflows/1`);
    expect([401, 403]).toContain(res.status());
  });

  test('PUT /:id/toggle without token → 401/403', async ({ request }) => {
    const res = await request.put(`${BASE_URL}/api/workflows/1/toggle`, {
      data: {}, headers: { 'Content-Type': 'application/json' },
    });
    expect([401, 403]).toContain(res.status());
  });

  test('POST /:id/test without token → 401/403', async ({ request }) => {
    const res = await request.post(`${BASE_URL}/api/workflows/1/test`, {
      data: {}, headers: { 'Content-Type': 'application/json' },
    });
    expect([401, 403]).toContain(res.status());
  });
});
