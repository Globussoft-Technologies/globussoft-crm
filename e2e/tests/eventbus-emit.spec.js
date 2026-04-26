// @ts-check
/**
 * eventBus.emitEvent() entry-point coverage.
 *
 * Covers the orchestration around the action dispatcher:
 *   - tenant scoping            — a rule on tenant A does NOT fire on a
 *                                 tenant-B-emitted event with the same name
 *   - isActive=false short-circuit — the findMany filter excludes inactive
 *                                 rules, so the engine never enters
 *                                 executeAction for them
 *   - multi-rule fan-out        — N rules with the same triggerType all
 *                                 fire on a single emit (each gets its own
 *                                 audit row)
 *   - exception isolation       — one rule failing should not abort sibling
 *                                 rules in the same emit (try/catch wrap
 *                                 in the for-of loop, eventBus.js line 187)
 *   - webhook side-channel      — emitEvent calls deliverWebhooks; we
 *                                 register a Webhook row pointing at a
 *                                 closed port (won't crash) and fire the
 *                                 corresponding event
 *
 * Test-data tag: every row created here is suffixed with E2E_FLOW_<6digits>
 * so global-teardown.js scrubs it.
 *
 * Backend reference:
 *   backend/lib/eventBus.js          — emitEvent + executeAction
 *   backend/lib/webhookDelivery.js   — deliverWebhooks (called from emitEvent)
 *   backend/routes/workflows.js      — /:id/test, /:id/toggle
 *   backend/routes/developer.js      — webhook CRUD
 */
const { test, expect } = require('@playwright/test');

const BASE_URL = process.env.BASE_URL || 'https://crm.globusdemos.com';
const API = `${BASE_URL}/api`;

const TENANT_A = { email: 'admin@globussoft.com', password: 'password123', label: 'generic' };
const TENANT_B = { email: 'admin@wellness.demo', password: 'password123', label: 'wellness' };

const TAG_SUFFIX = Date.now().toString().slice(-6);
const TAG = `E2E_FLOW_${TAG_SUFFIX}`;

let tokenA = '';
let tokenB = '';
let userIdA = null;
let userIdB = null;

const created = {
  rulesA: [],
  rulesB: [],
  webhooksA: [],
};

const authA = () => ({ Authorization: `Bearer ${tokenA}` });
const authB = () => ({ Authorization: `Bearer ${tokenB}` });

test.describe.configure({ mode: 'serial' });

test.describe('eventBus.emitEvent() — entry-point + orchestration', () => {
  test.beforeAll(async ({ request }) => {
    const a = await request.post(`${API}/auth/login`, { data: TENANT_A });
    expect(a.ok(), `tenant A login: ${a.status()} ${await a.text()}`).toBeTruthy();
    const aBody = await a.json();
    tokenA = aBody.token;
    userIdA = aBody.user?.id || aBody.userId || aBody.user?.userId || null;
    if (!userIdA) {
      const me = await request.get(`${API}/auth/me`, { headers: authA() });
      if (me.ok()) {
        const meBody = await me.json();
        userIdA = meBody.id || meBody.user?.id || null;
      }
    }
    expect(userIdA).toBeTruthy();

    const b = await request.post(`${API}/auth/login`, { data: TENANT_B });
    expect(b.ok(), `tenant B login: ${b.status()} ${await b.text()}`).toBeTruthy();
    const bBody = await b.json();
    tokenB = bBody.token;
    userIdB = bBody.user?.id || bBody.userId || bBody.user?.userId || null;
    if (!userIdB) {
      const me = await request.get(`${API}/auth/me`, { headers: authB() });
      if (me.ok()) {
        const meBody = await me.json();
        userIdB = meBody.id || meBody.user?.id || null;
      }
    }
    expect(userIdB).toBeTruthy();
  });

  test.afterAll(async ({ request }) => {
    for (const id of created.rulesA) {
      await request.delete(`${API}/workflows/${id}`, { headers: authA() }).catch(() => {});
    }
    for (const id of created.rulesB) {
      await request.delete(`${API}/workflows/${id}`, { headers: authB() }).catch(() => {});
    }
    for (const id of created.webhooksA) {
      await request.delete(`${API}/developer/webhooks/${id}`, { headers: authA() }).catch(() => {});
    }
  });

  // ── helpers ────────────────────────────────────────────────────────
  async function createRule(request, headers, { name, triggerType, actionType, targetState }) {
    const res = await request.post(`${API}/workflows`, {
      headers,
      data: {
        name,
        triggerType,
        actionType,
        targetState: typeof targetState === 'string' ? targetState : JSON.stringify(targetState),
      },
    });
    expect(res.status(), `rule create: ${res.status()} ${await res.text()}`).toBe(201);
    return res.json();
  }

  async function fire(request, headers, ruleId, payload) {
    const res = await request.post(`${API}/workflows/${ruleId}/test`, {
      headers,
      data: { payload },
    });
    expect(res.ok(), `fire: ${res.status()} ${await res.text()}`).toBeTruthy();
    await new Promise((r) => setTimeout(r, 600));
  }

  async function auditCount(request, headers, ruleId) {
    const res = await request.get(`${API}/audit?entity=AutomationRule&action=WORKFLOW`, { headers });
    expect(res.ok()).toBeTruthy();
    const rows = await res.json();
    return (rows || []).filter((r) => r.entityId === ruleId).length;
  }

  // ── tenant scoping ─────────────────────────────────────────────────
  // emitEvent's findMany has `where: {tenantId, triggerType, isActive}`. A
  // rule on tenant A must not run on a tenant-B emit. We POST /:id/test
  // under each tenant's auth — the route reads req.user.tenantId — and
  // confirm tenant A's rule audit count only changes when fired by tenant A.
  test('rule on tenant A does not fire when tenant B emits the same event', async ({ request }) => {
    const ruleA = await createRule(request, authA(), {
      name: `emit-tenantscope-A-${TAG}`,
      triggerType: 'deal.created',
      actionType: 'create_task',
      targetState: { title: `Tenant A scoped ${TAG}`, dueInDays: 1, assignToId: userIdA },
    });
    created.rulesA.push(ruleA.id);

    // Tenant B fires `deal.created` via its own /:id/test on a separate rule.
    // First we need a tenant-B rule (it can be inert — assign_agent with
    // missing userId is a no-op besides the audit).
    const ruleB = await createRule(request, authB(), {
      name: `emit-tenantscope-B-${TAG}`,
      triggerType: 'deal.created',
      actionType: 'create_task',
      targetState: { title: `Tenant B scoped ${TAG}`, dueInDays: 1, assignToId: userIdB },
    });
    created.rulesB.push(ruleB.id);

    const beforeA = await auditCount(request, authA(), ruleA.id);

    // Tenant B emits — under tenant B's auth, /workflows/:id/test reads
    // req.user.tenantId = B, so emitEvent runs with tenantId=B and
    // findMany excludes tenant A's rule entirely.
    await fire(request, authB(), ruleB.id, { dealId: 99 });

    const afterA = await auditCount(request, authA(), ruleA.id);
    expect(afterA - beforeA, 'tenant A rule must NOT fire on tenant B emit').toBe(0);

    // Sanity check: tenant A firing under its own auth still works.
    const beforeASelf = await auditCount(request, authA(), ruleA.id);
    await fire(request, authA(), ruleA.id, { dealId: 100 });
    const afterASelf = await auditCount(request, authA(), ruleA.id);
    expect(afterASelf - beforeASelf, 'tenant A rule fires on tenant A emit').toBeGreaterThanOrEqual(1);
  });

  // ── isActive=false short-circuit ───────────────────────────────────
  test('isActive=false rule is excluded by emitEvent.findMany (no audit row)', async ({ request }) => {
    const rule = await createRule(request, authA(), {
      name: `emit-inactive-${TAG}`,
      triggerType: 'deal.lost',
      actionType: 'create_task',
      targetState: { title: `Should not fire ${TAG}`, dueInDays: 1, assignToId: userIdA },
    });
    created.rulesA.push(rule.id);

    // Toggle to inactive.
    const tog = await request.put(`${API}/workflows/${rule.id}/toggle`, { headers: authA() });
    expect(tog.ok()).toBeTruthy();
    const toggled = await tog.json();
    expect(toggled.isActive).toBe(false);

    const before = await auditCount(request, authA(), rule.id);
    await fire(request, authA(), rule.id, { dealId: 50 });
    const after = await auditCount(request, authA(), rule.id);
    // /:id/test calls emitEvent which only loads isActive=true rules. The
    // route returns 200 either way but no audit row is written for this rule.
    expect(after - before, 'inactive rule must not produce an audit row').toBe(0);
  });

  // ── multi-rule fan-out ─────────────────────────────────────────────
  test('multiple rules with the same triggerType all fire on a single emit', async ({ request }) => {
    // Three rules on the same trigger, each with a unique tag in its name
    // so we can independently verify each one's audit row.
    const rules = [];
    for (let i = 0; i < 3; i++) {
      const r = await createRule(request, authA(), {
        name: `emit-fanout-${i}-${TAG}`,
        triggerType: 'task.completed',
        actionType: 'create_task',
        targetState: { title: `Fan-out ${i} ${TAG}`, dueInDays: 1, assignToId: userIdA },
      });
      created.rulesA.push(r.id);
      rules.push(r);
    }

    const beforeCounts = await Promise.all(rules.map((r) => auditCount(request, authA(), r.id)));

    // Single emit, picks up all three rules.
    await fire(request, authA(), rules[0].id, { taskId: 1, userId: userIdA });

    const afterCounts = await Promise.all(rules.map((r) => auditCount(request, authA(), r.id)));
    for (let i = 0; i < 3; i++) {
      expect(
        afterCounts[i] - beforeCounts[i],
        `rule #${i} must fire on the shared emit (got delta ${afterCounts[i] - beforeCounts[i]})`
      ).toBeGreaterThanOrEqual(1);
    }
  });

  // ── exception isolation ────────────────────────────────────────────
  // create_approval with bad targetState (entity: not-a-string) hits the
  // "missing entity" warn-and-break, which is graceful — not a throw. To
  // exercise the try/catch in the emit loop we need a rule that throws.
  // update_field with an unknown entity does NOT throw (model is undefined,
  // engine just falls through). The most reliable way to trigger a thrown
  // exception is a malformed targetState that breaks JSON.parse on entry
  // — line 201 of eventBus.js: `JSON.parse(rule.targetState)`. The
  // /workflows POST/PUT validator coerces objects to strings but does NOT
  // re-validate JSON-string shape, so we PUT a deliberately broken string
  // bypassing the createRule helper.
  test('a rule that throws does not abort sibling rules in the same emit', async ({ request }) => {
    // Two rules: one good, one with broken targetState.
    const goodRule = await createRule(request, authA(), {
      name: `emit-isolation-good-${TAG}`,
      triggerType: 'ticket.updated',
      actionType: 'create_task',
      targetState: { title: `Isolation good ${TAG}`, dueInDays: 1, assignToId: userIdA },
    });
    created.rulesA.push(goodRule.id);

    const badRule = await createRule(request, authA(), {
      name: `emit-isolation-bad-${TAG}`,
      triggerType: 'ticket.updated',
      actionType: 'create_task',
      targetState: { title: 'placeholder', dueInDays: 1, assignToId: userIdA },
    });
    created.rulesA.push(badRule.id);

    // Stuff broken JSON into the bad rule's targetState. The PUT route
    // does `data.targetState = typeof === "object" ? JSON.stringify : raw`
    // — passing a raw string preserves it verbatim.
    const put = await request.put(`${API}/workflows/${badRule.id}`, {
      headers: authA(),
      data: { targetState: '{not valid json' },
    });
    expect(put.ok()).toBeTruthy();

    const beforeGood = await auditCount(request, authA(), goodRule.id);

    // Single emit. emitEvent iterates rules in id-order; whichever runs
    // first, the other's try/catch ensures it still gets to run.
    await fire(request, authA(), goodRule.id, { ticketId: 7 });

    const afterGood = await auditCount(request, authA(), goodRule.id);
    expect(
      afterGood - beforeGood,
      'good rule must still fire even when sibling threw on JSON.parse'
    ).toBeGreaterThanOrEqual(1);
  });

  // ── webhook side-channel ───────────────────────────────────────────
  // emitEvent calls deliverWebhooks at the end, regardless of how many
  // automation rules ran. We register a Webhook row pointing at a closed
  // port (deliverSingle catches the connect error) and emit a matching
  // event. Assertion: no crash, and the rule we used to drive the emit
  // produced its audit row (i.e. emitEvent finished both phases).
  test('emitEvent invokes deliverWebhooks; failure on the webhook side does not break rule execution', async ({ request }) => {
    const wh = await request.post(`${API}/developer/webhooks`, {
      headers: authA(),
      data: { event: 'invoice.paid', targetUrl: 'http://127.0.0.1:1/e2e-stub' },
    });
    expect(wh.status()).toBe(201);
    const webhook = await wh.json();
    created.webhooksA.push(webhook.id);

    const rule = await createRule(request, authA(), {
      name: `emit-webhook-${TAG}`,
      triggerType: 'invoice.paid',
      actionType: 'create_task',
      targetState: { title: `Webhook coexists ${TAG}`, dueInDays: 1, assignToId: userIdA },
    });
    created.rulesA.push(rule.id);

    const before = await auditCount(request, authA(), rule.id);
    await fire(request, authA(), rule.id, { invoiceId: 1, userId: userIdA });
    const after = await auditCount(request, authA(), rule.id);
    expect(after - before).toBeGreaterThanOrEqual(1);
  });
});
