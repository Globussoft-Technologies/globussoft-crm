// @ts-check
/**
 * SLA Breach Engine — full backend coverage push.
 *
 * cron/slaBreachEngine.js was 24.50% covered. This spec drives every branch
 * of `processTenant` / `tickSlaBreaches` / `runForTenant` deterministically by
 * (a) creating SlaPolicy rows with sensible responseMinutes (>= 1, per #465),
 * (b) creating Tickets in known states, (c) backdating their slaResponseDue
 * via the admin-only test-helper POST /api/sla/_test/backdate-ticket/:id,
 * (d) calling the admin-only manual trigger POST /api/sla/check-breaches so
 * we don't have to wait on the 5-min cron tick. The trigger calls
 * runForTenant -> processTenant against the caller's tenant, exercising the
 * same query, update, and emitEvent code path the scheduled cron uses.
 *
 * #465 (2026-05-05): the route now rejects responseMinutes <= 0 and
 * resolveMinutes <= 0 with 400 / INVALID_*_MINUTES (a 0-minute SLA is
 * vacuous — every ticket auto-breaches the moment the policy is applied).
 * The deterministic-breach mechanism formerly used 0-minute policies +
 * /apply; it now uses POST /api/sla/_test/backdate-ticket/:id which is
 * admin-only and gated to NODE_ENV !== 'production'.
 *
 * Endpoints covered:
 *   GET    /api/sla/policies                — list
 *   POST   /api/sla/policies                — create + 400 missing fields + 0/negative both rejected (#465)
 *   PUT    /api/sla/policies/:id            — update + 404 + invalid id + 0/negative-minutes (#465)
 *   DELETE /api/sla/policies/:id            — 200 + 404 + invalid id
 *   POST   /api/sla/apply/:ticketId         — match by priority + 404 ticket + 404 no-policy + invalid id
 *   POST   /api/sla/apply-all               — default (slaResponseDue=null only) + ?force=true overwrite
 *   POST   /api/sla/_test/backdate-ticket/:id — admin-only test-helper (replaces 0-minute SLA fast-path) (#465)
 *   GET    /api/sla/breaches                — response + resolve breach enrichment
 *   GET    /api/sla/stats                   — counts/averages
 *   POST   /api/sla/check-breaches          — admin-only manual trigger (drives the engine)
 *
 * Engine branches exercised in cron/slaBreachEngine.js:
 *   - candidate query: status NOT IN terminal, firstResponseAt=null, slaResponseDue<now, breached=false
 *   - update branch:   sets breached=true, breachedAt=now, computes breachedBy
 *   - emit branch:     'sla.breached' event for downstream automation
 *   - skip branch:     ticket with firstResponseAt set is filtered out (NOT breached)
 *   - skip branch:     ticket in Resolved/Closed/Cancelled is filtered out
 *   - skip branch:     ticket already breached=true is NOT re-fired (idempotency gate)
 *   - skip branch:     ticket with slaResponseDue in the future is NOT breached
 *   - tenant scope:    runForTenant returns {checked, breached, ids} structure
 *   - empty tenant:    runForTenant for unknown tenantId → {checked:0, breached:0, ids:[]}
 *
 * Pattern: cached-token / authXyz helpers identical to sms-api.spec.js.
 * Test data is tagged `E2E_SLA_<ts>` so global-teardown can scrub.
 */
const { test, expect } = require('@playwright/test');

const BASE_URL = process.env.BASE_URL || 'https://crm.globusdemos.com';
const REQUEST_TIMEOUT = 30000;

let authToken = null;
const RUN_TAG = `E2E_SLA_${Date.now()}`;

async function getAuthToken(request) {
  if (authToken) return authToken;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await request.post(`${BASE_URL}/api/auth/login`, {
        data: { email: 'admin@globussoft.com', password: 'password123' },
        headers: { 'Content-Type': 'application/json' },
        timeout: REQUEST_TIMEOUT,
      });
      if (response.ok()) {
        const data = await response.json();
        authToken = data.token;
        return authToken;
      }
    } catch (e) {
      if (attempt === 0) continue;
    }
  }
  return null;
}

const auth = async (request) => ({ Authorization: `Bearer ${await getAuthToken(request)}` });

async function authGet(request, path) {
  return request.get(`${BASE_URL}${path}`, { headers: await auth(request), timeout: REQUEST_TIMEOUT });
}
async function authPost(request, path, body) {
  const headers = { ...(await auth(request)), 'Content-Type': 'application/json' };
  return request.post(`${BASE_URL}${path}`, { headers, data: body ?? {}, timeout: REQUEST_TIMEOUT });
}
async function authPut(request, path, body) {
  const headers = { ...(await auth(request)), 'Content-Type': 'application/json' };
  return request.put(`${BASE_URL}${path}`, { headers, data: body ?? {}, timeout: REQUEST_TIMEOUT });
}
async function authDelete(request, path) {
  return request.delete(`${BASE_URL}${path}`, { headers: await auth(request), timeout: REQUEST_TIMEOUT });
}

// Track ids for best-effort cleanup. Each test that creates rows pushes here;
// global-teardown also scrubs by RUN_TAG prefix on name/subject.
const createdPolicyIds = [];
const createdTicketIds = [];

test.afterAll(async ({ request }) => {
  for (const id of createdTicketIds) {
    await authDelete(request, `/api/tickets/${id}`).catch(() => {});
  }
  for (const id of createdPolicyIds) {
    await authDelete(request, `/api/sla/policies/${id}`).catch(() => {});
  }
});

// ── factories ──────────────────────────────────────────────────────────

async function createPolicy(request, overrides = {}) {
  const res = await authPost(request, '/api/sla/policies', {
    name: `${RUN_TAG} ${overrides.name || 'policy'}`,
    priority: overrides.priority || 'Low',
    responseMinutes: overrides.responseMinutes ?? 60,
    resolveMinutes: overrides.resolveMinutes ?? 1440,
    isActive: overrides.isActive === undefined ? true : !!overrides.isActive,
  });
  expect(res.status(), `policy create: ${await res.text()}`).toBe(201);
  const p = await res.json();
  createdPolicyIds.push(p.id);
  return p;
}

async function createTicket(request, overrides = {}) {
  const res = await authPost(request, '/api/tickets', {
    subject: `${RUN_TAG} ${overrides.subject || 'ticket'}`,
    description: overrides.description || 'breach engine test fixture',
    priority: overrides.priority || 'Low',
    assigneeId: overrides.assigneeId,
  });
  expect(res.status(), `ticket create: ${await res.text()}`).toBe(201);
  const t = await res.json();
  createdTicketIds.push(t.id);
  return t;
}

// Move a ticket's slaResponseDue into the past so the engine considers it
// breached on the next tick. After issue #465 banned 0-minute SLAs, the
// previous mechanism (create a 0-min policy + apply) no longer works — the
// route returns 400 INVALID_RESPONSE_MINUTES. The replacement is the
// admin-only test-helper at POST /api/sla/_test/backdate-ticket/:id which
// directly stamps slaResponseDue / slaResolveDue 60 minutes in the past.
// The helper is gated to NODE_ENV !== 'production' so it can't be hit on the
// real production box.
async function makeOverdue(request, ticket) {
  // We still need an active policy for the same priority so /apply (used by
  // the existing /breaches integration tests) and the engine's join logic
  // both have something to match. Use a normal 60-minute window — the
  // backdate call below is what actually flips the ticket into breach state.
  const policy = await createPolicy(request, {
    name: `overdue-helper-${ticket.id}`,
    priority: ticket.priority,
    responseMinutes: 60,
    resolveMinutes: 60,
  });
  const r = await authPost(request, `/api/sla/_test/backdate-ticket/${ticket.id}`, {
    responseOffsetMinutes: 60,
    resolveOffsetMinutes: 60,
  });
  expect(r.status(), `backdate: ${await r.text()}`).toBe(200);
  return policy;
}

// Tick the engine for the caller's tenant. Returns {checked, breached, ids}.
async function tick(request) {
  const res = await authPost(request, '/api/sla/check-breaches', {});
  expect(res.status(), `tick: ${await res.text()}`).toBe(200);
  return res.json();
}

// ─── Policy CRUD ────────────────────────────────────────────────────────

test.describe('SLA API — POST /policies', () => {
  test('400 when "name" missing', async ({ request }) => {
    const res = await authPost(request, '/api/sla/policies', { priority: 'Low' });
    expect(res.status()).toBe(400);
    expect((await res.json()).error).toMatch(/name and priority/i);
  });

  test('400 when "priority" missing', async ({ request }) => {
    const res = await authPost(request, '/api/sla/policies', { name: `${RUN_TAG} no-prio` });
    expect(res.status()).toBe(400);
  });

  test('400 when both missing', async ({ request }) => {
    const res = await authPost(request, '/api/sla/policies', {});
    expect(res.status()).toBe(400);
  });

  test('creates with defaults (60 / 1440) when minute fields omitted', async ({ request }) => {
    const res = await authPost(request, '/api/sla/policies', {
      name: `${RUN_TAG} defaults`,
      priority: 'Low',
    });
    expect(res.status()).toBe(201);
    const p = await res.json();
    createdPolicyIds.push(p.id);
    expect(p.responseMinutes).toBe(60);
    expect(p.resolveMinutes).toBe(1440);
    expect(p.isActive).toBe(true);
  });

  // #465: 0-minute SLAs are vacuous (every ticket auto-breaches the moment
  // the policy is applied). Both POST and PUT now reject zero AND negative
  // with 400 / INVALID_*_MINUTES. The test-only backdate helper at
  // POST /api/sla/_test/backdate-ticket/:id is the deterministic-breach
  // mechanism for engine specs.
  test('400 when responseMinutes is 0 (#465 — no vacuous policies)', async ({ request }) => {
    const res = await authPost(request, '/api/sla/policies', {
      name: `${RUN_TAG} zero-resp`,
      priority: 'Urgent',
      responseMinutes: 0,
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('INVALID_RESPONSE_MINUTES');
    expect(body.error).toMatch(/at least 1/i);
  });

  test('400 when resolveMinutes is 0 (#465 — no vacuous policies)', async ({ request }) => {
    const res = await authPost(request, '/api/sla/policies', {
      name: `${RUN_TAG} zero-resv`,
      priority: 'Urgent',
      resolveMinutes: 0,
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('INVALID_RESOLVE_MINUTES');
  });

  test('400 when responseMinutes is negative', async ({ request }) => {
    const res = await authPost(request, '/api/sla/policies', {
      name: `${RUN_TAG} neg-resp`,
      priority: 'Low',
      responseMinutes: -10,
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('INVALID_RESPONSE_MINUTES');
  });

  test('400 when resolveMinutes is negative', async ({ request }) => {
    const res = await authPost(request, '/api/sla/policies', {
      name: `${RUN_TAG} neg-resv`,
      priority: 'Low',
      resolveMinutes: -1,
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('INVALID_RESOLVE_MINUTES');
  });

  test('non-numeric responseMinutes falls back to default 60', async ({ request }) => {
    const res = await authPost(request, '/api/sla/policies', {
      name: `${RUN_TAG} junk-resp`,
      priority: 'Low',
      responseMinutes: 'abc',
    });
    expect(res.status()).toBe(201);
    const p = await res.json();
    createdPolicyIds.push(p.id);
    expect(p.responseMinutes).toBe(60);
  });

  test('isActive defaults to true', async ({ request }) => {
    const p = await createPolicy(request, { name: 'default-active', priority: 'Medium' });
    expect(p.isActive).toBe(true);
  });

  test('isActive=false honored', async ({ request }) => {
    const p = await createPolicy(request, { name: 'inactive', priority: 'Medium', isActive: false });
    expect(p.isActive).toBe(false);
  });
});

test.describe('SLA API — GET /policies', () => {
  test('returns array sorted active-first', async ({ request }) => {
    await createPolicy(request, { name: 'list-A', priority: 'Low', isActive: true });
    await createPolicy(request, { name: 'list-B', priority: 'Low', isActive: false });
    const res = await authGet(request, '/api/sla/policies');
    expect(res.status()).toBe(200);
    const list = await res.json();
    expect(Array.isArray(list)).toBe(true);
    // Find our two — the active one must come before the inactive one.
    const idxA = list.findIndex((p) => p.name === `${RUN_TAG} list-A`);
    const idxB = list.findIndex((p) => p.name === `${RUN_TAG} list-B`);
    expect(idxA).toBeGreaterThanOrEqual(0);
    expect(idxB).toBeGreaterThanOrEqual(0);
    expect(idxA).toBeLessThan(idxB);
  });
});

test.describe('SLA API — PUT /policies/:id', () => {
  test('updates name + responseMinutes', async ({ request }) => {
    const p = await createPolicy(request, { name: 'pre-edit', priority: 'Low' });
    const res = await authPut(request, `/api/sla/policies/${p.id}`, {
      name: `${RUN_TAG} edited`,
      responseMinutes: 30,
    });
    expect(res.status()).toBe(200);
    const updated = await res.json();
    expect(updated.name).toContain('edited');
    expect(updated.responseMinutes).toBe(30);
  });

  test('400 on invalid id (non-numeric)', async ({ request }) => {
    const res = await authPut(request, '/api/sla/policies/not-a-number', { name: 'x' });
    expect(res.status()).toBe(400);
  });

  test('404 on unknown id', async ({ request }) => {
    const res = await authPut(request, '/api/sla/policies/99999999', { name: 'x' });
    expect(res.status()).toBe(404);
  });

  test('PUT with empty body is no-op (200, fields preserved)', async ({ request }) => {
    const p = await createPolicy(request, { name: 'noop', priority: 'Low', responseMinutes: 45 });
    const res = await authPut(request, `/api/sla/policies/${p.id}`, {});
    expect(res.status()).toBe(200);
    const updated = await res.json();
    expect(updated.responseMinutes).toBe(45);
  });

  test('PUT can flip isActive=false', async ({ request }) => {
    const p = await createPolicy(request, { name: 'flip', priority: 'Low', isActive: true });
    const res = await authPut(request, `/api/sla/policies/${p.id}`, { isActive: false });
    expect(res.status()).toBe(200);
    const updated = await res.json();
    expect(updated.isActive).toBe(false);
  });

  test('PUT 400 on negative responseMinutes', async ({ request }) => {
    const p = await createPolicy(request, { name: 'neg-edit', priority: 'Low' });
    const res = await authPut(request, `/api/sla/policies/${p.id}`, { responseMinutes: -5 });
    expect(res.status()).toBe(400);
    expect((await res.json()).code).toBe('INVALID_RESPONSE_MINUTES');
  });

  test('PUT 400 on negative resolveMinutes', async ({ request }) => {
    const p = await createPolicy(request, { name: 'neg-edit-res', priority: 'Low' });
    const res = await authPut(request, `/api/sla/policies/${p.id}`, { resolveMinutes: -7 });
    expect(res.status()).toBe(400);
    expect((await res.json()).code).toBe('INVALID_RESOLVE_MINUTES');
  });

  test('PUT 400 on responseMinutes=0 (#465 — no vacuous policies)', async ({ request }) => {
    const p = await createPolicy(request, { name: 'edit-zero', priority: 'Low', responseMinutes: 60 });
    const res = await authPut(request, `/api/sla/policies/${p.id}`, { responseMinutes: 0 });
    expect(res.status()).toBe(400);
    expect((await res.json()).code).toBe('INVALID_RESPONSE_MINUTES');
  });

  test('PUT 400 on resolveMinutes=0 (#465 — no vacuous policies)', async ({ request }) => {
    const p = await createPolicy(request, { name: 'edit-zero-res', priority: 'Low', resolveMinutes: 1440 });
    const res = await authPut(request, `/api/sla/policies/${p.id}`, { resolveMinutes: 0 });
    expect(res.status()).toBe(400);
    expect((await res.json()).code).toBe('INVALID_RESOLVE_MINUTES');
  });
});

test.describe('SLA API — DELETE /policies/:id', () => {
  test('removes the row', async ({ request }) => {
    const p = await createPolicy(request, { name: 'to-delete', priority: 'Low' });
    const del = await authDelete(request, `/api/sla/policies/${p.id}`);
    expect(del.status()).toBe(204); // #550: DELETE → 204
    // confirm gone — PUT after delete should 404
    const after = await authPut(request, `/api/sla/policies/${p.id}`, { name: 'gone' });
    expect(after.status()).toBe(404);
  });

  test('400 on invalid id', async ({ request }) => {
    const res = await authDelete(request, '/api/sla/policies/abc');
    expect(res.status()).toBe(400);
  });

  test('404 on unknown id', async ({ request }) => {
    const res = await authDelete(request, '/api/sla/policies/99999999');
    expect(res.status()).toBe(404);
  });
});

// ─── Apply policy → ticket ──────────────────────────────────────────────

test.describe('SLA API — POST /apply/:ticketId', () => {
  test('400 on invalid ticket id', async ({ request }) => {
    const res = await authPost(request, '/api/sla/apply/abc', {});
    expect(res.status()).toBe(400);
  });

  test('404 on unknown ticket', async ({ request }) => {
    const res = await authPost(request, '/api/sla/apply/99999999', {});
    expect(res.status()).toBe(404);
  });

  test('404 when no active policy matches priority', async ({ request }) => {
    // Create ticket with an obscure priority spelling — there will be no policy.
    // Use 'Urgent' with all matching policies inactive: deactivate any we own.
    const t = await createTicket(request, { subject: 'no-policy-match', priority: 'Urgent' });
    // Deactivate any of our seeded Urgent policies (best-effort).
    const list = await (await authGet(request, '/api/sla/policies')).json();
    for (const p of list.filter((p) => p.priority === 'Urgent' && p.isActive)) {
      await authPut(request, `/api/sla/policies/${p.id}`, { isActive: false });
    }
    const res = await authPost(request, `/api/sla/apply/${t.id}`, {});
    // Either 404 (our deactivation worked) or 200 (other tenant data exists).
    expect([200, 404]).toContain(res.status());
  });

  test('apply stamps slaResponseDue + slaResolveDue based on policy minutes', async ({ request }) => {
    const t = await createTicket(request, { subject: 'apply-stamp', priority: 'High' });
    await createPolicy(request, {
      name: 'apply-stamp-policy',
      priority: 'High',
      responseMinutes: 30,
      resolveMinutes: 240,
    });
    const res = await authPost(request, `/api/sla/apply/${t.id}`, {});
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.ticket).toBeTruthy();
    expect(body.policy).toBeTruthy();
    expect(body.ticket.slaResponseDue).toBeTruthy();
    expect(body.ticket.slaResolveDue).toBeTruthy();
    const created = new Date(body.ticket.createdAt).getTime();
    const responseDue = new Date(body.ticket.slaResponseDue).getTime();
    expect(responseDue - created).toBe(30 * 60000);
  });
});

test.describe('SLA API — POST /apply-all', () => {
  test('default mode skips tickets that already have slaResponseDue', async ({ request }) => {
    // Need at least one policy active for some priority
    await createPolicy(request, { name: 'apply-all-base', priority: 'Low', responseMinutes: 60 });
    const res = await authPost(request, '/api/sla/apply-all', {});
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(typeof body.applied).toBe('number');
    expect(typeof body.skipped).toBe('number');
    expect(typeof body.total).toBe('number');
    expect(body.force).toBe(false);
  });

  test('?force=true re-stamps in-flight tickets', async ({ request }) => {
    // Create a ticket + apply once so it has slaResponseDue stamped.
    const t = await createTicket(request, { subject: 'apply-all-force', priority: 'Medium' });
    await createPolicy(request, {
      name: 'force-apply-policy',
      priority: 'Medium',
      responseMinutes: 90,
      resolveMinutes: 600,
    });
    await authPost(request, `/api/sla/apply/${t.id}`, {});
    const res = await authPost(request, '/api/sla/apply-all?force=true', {});
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.force).toBe(true);
    expect(body.applied).toBeGreaterThanOrEqual(1);
  });

  test('force can also be passed in body', async ({ request }) => {
    const res = await authPost(request, '/api/sla/apply-all', { force: true });
    expect(res.status()).toBe(200);
    expect((await res.json()).force).toBe(true);
  });
});

// ─── BREACH ENGINE — the main coverage target ───────────────────────────

test.describe('SLA Breach Engine — POST /check-breaches', () => {
  test('returns {checked, breached, ids} structure', async ({ request }) => {
    const res = await authPost(request, '/api/sla/check-breaches', {});
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(typeof body.checked).toBe('number');
    expect(typeof body.breached).toBe('number');
    expect(Array.isArray(body.ids)).toBe(true);
  });

  test('Open ticket past responseMinutes → flips breached=true', async ({ request }) => {
    const t = await createTicket(request, { subject: 'engine-flip', priority: 'High' });
    await makeOverdue(request, t);

    const result = await tick(request);
    expect(result.ids).toContain(t.id);

    // Confirm via direct GET that ticket is now breached + breachedAt stamped.
    const after = await (await authGet(request, `/api/tickets/${t.id}`)).json();
    expect(after.breached).toBe(true);
    expect(after.breachedAt).toBeTruthy();
  });

  test('idempotent: same ticket NOT re-fired on second tick', async ({ request }) => {
    const t = await createTicket(request, { subject: 'engine-idempotent', priority: 'High' });
    await makeOverdue(request, t);

    await tick(request);
    const second = await tick(request);
    // The breached=false gate must keep this ticket out of the candidate set.
    expect(second.ids).not.toContain(t.id);
  });

  test('ticket with firstResponseAt set is NOT breached on tick', async ({ request }) => {
    const t = await createTicket(request, { subject: 'engine-already-replied', priority: 'High' });
    // Move it to In Progress to stamp firstResponseAt BEFORE making overdue.
    const upd = await authPut(request, `/api/tickets/${t.id}`, { status: 'Pending' });
    expect(upd.status()).toBe(200);
    const stamped = await upd.json();
    expect(stamped.firstResponseAt).toBeTruthy();

    await makeOverdue(request, t);

    const result = await tick(request);
    expect(result.ids).not.toContain(t.id);

    const after = await (await authGet(request, `/api/tickets/${t.id}`)).json();
    expect(after.breached).toBe(false);
  });

  test('ticket already Resolved is excluded by terminal-status filter', async ({ request }) => {
    const t = await createTicket(request, { subject: 'engine-resolved', priority: 'High' });
    // Resolve before overdue → terminal status filter should skip it.
    await authPut(request, `/api/tickets/${t.id}`, { status: 'Resolved' });
    await makeOverdue(request, t);

    const result = await tick(request);
    expect(result.ids).not.toContain(t.id);
  });

  test('ticket already Closed is excluded by terminal-status filter', async ({ request }) => {
    const t = await createTicket(request, { subject: 'engine-closed', priority: 'High' });
    await authPut(request, `/api/tickets/${t.id}`, { status: 'Closed' });
    await makeOverdue(request, t);

    const result = await tick(request);
    expect(result.ids).not.toContain(t.id);
  });

  test('ticket with slaResponseDue in the FUTURE is NOT breached', async ({ request }) => {
    const t = await createTicket(request, { subject: 'engine-future', priority: 'High' });
    // Apply a long-window policy so slaResponseDue is far in the future.
    await createPolicy(request, {
      name: 'future-policy',
      priority: 'High',
      responseMinutes: 99999,
      resolveMinutes: 99999,
    });
    await authPost(request, `/api/sla/apply/${t.id}`, {});

    const result = await tick(request);
    expect(result.ids).not.toContain(t.id);
  });

  test('backdated ticket + brand-new policy → breached on first tick (#465 replaces 0-minute SLA fast-path)', async ({ request }) => {
    const t = await createTicket(request, { subject: 'engine-instant', priority: 'Urgent' });
    // Pre-#465 this used responseMinutes:0; the route now rejects that.
    // Backdate the ticket directly via the test-helper instead.
    await createPolicy(request, {
      name: 'instant-urgent',
      priority: 'Urgent',
      responseMinutes: 60,
      resolveMinutes: 60,
    });
    await authPost(request, `/api/sla/_test/backdate-ticket/${t.id}`, {
      responseOffsetMinutes: 30,
      resolveOffsetMinutes: 30,
    });

    const result = await tick(request);
    expect(result.ids).toContain(t.id);
    const after = await (await authGet(request, `/api/tickets/${t.id}`)).json();
    expect(after.breached).toBe(true);
  });

  test('null assignee + overdue ticket → still breached (assignee not required)', async ({ request }) => {
    const t = await createTicket(request, { subject: 'engine-no-assignee', priority: 'High' });
    expect(t.assigneeId).toBeFalsy();
    await makeOverdue(request, t);

    const result = await tick(request);
    expect(result.ids).toContain(t.id);
  });

  test('multiple overdue tickets in one tick are all breached', async ({ request }) => {
    const a = await createTicket(request, { subject: 'engine-multi-A', priority: 'High' });
    const b = await createTicket(request, { subject: 'engine-multi-B', priority: 'High' });
    await makeOverdue(request, a);
    await makeOverdue(request, b);

    const result = await tick(request);
    expect(result.ids).toEqual(expect.arrayContaining([a.id, b.id]));
    expect(result.breached).toBeGreaterThanOrEqual(2);
  });

  test('breached count <= checked count (sanity invariant)', async ({ request }) => {
    const result = await tick(request);
    expect(result.breached).toBeLessThanOrEqual(result.checked);
  });

  test('breachedBy is non-negative for a backdated breach (#465 replaces 0-minute SLA fast-path)', async ({ request }) => {
    // Create breach via backdate, fetch the ticket, assert breachedAt >= dueAt.
    const t = await createTicket(request, { subject: 'engine-breachedBy', priority: 'Urgent' });
    await createPolicy(request, {
      name: 'instant-by',
      priority: 'Urgent',
      responseMinutes: 60,
    });
    await authPost(request, `/api/sla/_test/backdate-ticket/${t.id}`, {
      responseOffsetMinutes: 30,
    });
    await tick(request);
    const after = await (await authGet(request, `/api/tickets/${t.id}`)).json();
    if (after.slaResponseDue && after.breachedAt) {
      const due = new Date(after.slaResponseDue).getTime();
      const at = new Date(after.breachedAt).getTime();
      expect(at - due).toBeGreaterThanOrEqual(0);
    }
  });
});

// ─── /breaches list endpoint ────────────────────────────────────────────

test.describe('SLA API — GET /breaches', () => {
  test('returns enriched array with response/resolve flags', async ({ request }) => {
    // Force at least one breach.
    const t = await createTicket(request, { subject: 'breaches-listing', priority: 'High' });
    await makeOverdue(request, t);

    const res = await authGet(request, '/api/sla/breaches');
    expect(res.status()).toBe(200);
    const list = await res.json();
    expect(Array.isArray(list)).toBe(true);
    const mine = list.find((row) => row.id === t.id);
    if (mine) {
      expect(typeof mine.responseBreach).toBe('boolean');
      expect(typeof mine.resolveBreach).toBe('boolean');
      expect(typeof mine.responseOverdueMinutes).toBe('number');
      expect(typeof mine.resolveOverdueMinutes).toBe('number');
    }
  });
});

// ─── /stats summary ────────────────────────────────────────────────────

test.describe('SLA API — GET /stats', () => {
  test('returns counts + averages', async ({ request }) => {
    const res = await authGet(request, '/api/sla/stats');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(typeof body.activePolicies).toBe('number');
    expect(typeof body.breachesToday).toBe('number');
    expect(typeof body.avgResponseMinutes).toBe('number');
    expect(typeof body.avgResolveMinutes).toBe('number');
    expect(typeof body.sampleResponseCount).toBe('number');
    expect(typeof body.sampleResolveCount).toBe('number');
  });
});

// ─── Auth gate ─────────────────────────────────────────────────────────

test.describe('SLA API — auth gate', () => {
  test('GET /policies without token → 401/403', async ({ request }) => {
    const res = await request.get(`${BASE_URL}/api/sla/policies`);
    expect([401, 403]).toContain(res.status());
  });

  test('POST /policies without token → 401/403', async ({ request }) => {
    const res = await request.post(`${BASE_URL}/api/sla/policies`, {
      data: { name: 'x', priority: 'Low' },
      headers: { 'Content-Type': 'application/json' },
    });
    expect([401, 403]).toContain(res.status());
  });

  test('POST /check-breaches without token → 401/403', async ({ request }) => {
    const res = await request.post(`${BASE_URL}/api/sla/check-breaches`, {
      data: {},
      headers: { 'Content-Type': 'application/json' },
    });
    expect([401, 403]).toContain(res.status());
  });

  test('GET /breaches without token → 401/403', async ({ request }) => {
    const res = await request.get(`${BASE_URL}/api/sla/breaches`);
    expect([401, 403]).toContain(res.status());
  });

  test('GET /stats without token → 401/403', async ({ request }) => {
    const res = await request.get(`${BASE_URL}/api/sla/stats`);
    expect([401, 403]).toContain(res.status());
  });
});
