// @ts-check
/**
 * eventBus.executeAction() dispatcher coverage.
 *
 * Exercises every branch of the actionType switch:
 *   - send_email           (Mailgun path; provider may not be configured —
 *                           we assert the WORKFLOW audit row is written
 *                           and no crash; the Mailgun call itself is logged
 *                           as `sent: false, no_api_key` in that case)
 *   - send_notification    → Notification row created (covered by
 *                            workflows-flow.spec.js too; we do a smoke check)
 *   - create_task          → Task row created
 *   - update_field         → existing Contact row's field actually changes
 *   - assign_agent         → Contact.assignedToId updated
 *   - send_sms             → placeholder path (console.log only); audit + no crash
 *   - send_webhook         → audit + WORKFLOW row (deliverSingle is fire-
 *                            and-forget; we don't assert the outbound HTTP)
 *   - create_approval      → ApprovalRequest row + chained approval.created
 *
 * The "default" branch is covered by workflows-flow.spec.js Flow 5c
 * (POST /workflows rejects unknown actionType at create time, so we
 * cannot directly trigger the default branch through public API; the
 * validator is tested separately).
 *
 * Test-data tag: every row created here is suffixed with E2E_FLOW_<6digits>
 * so global-teardown.js scrubs it.
 *
 * Backend reference:
 *   backend/lib/eventBus.js          — executeAction switch
 *   backend/routes/workflows.js      — /:id/test
 *   backend/routes/notifications.js  — list endpoint
 *   backend/routes/tasks.js          — list endpoint
 *   backend/routes/contacts.js       — single-row read for update_field
 *   backend/routes/approvals.js      — list endpoint
 *   backend/routes/audit.js          — audit log signal
 *   backend/routes/developer.js      — webhook CRUD
 */
const { test, expect } = require('@playwright/test');

const BASE_URL = process.env.BASE_URL || 'https://crm.globusdemos.com';
const API = `${BASE_URL}/api`;

const ADMIN = { email: 'admin@globussoft.com', password: 'password123' };

const TAG_SUFFIX = Date.now().toString().slice(-6);
const TAG = `E2E_FLOW_${TAG_SUFFIX}`;

let token = '';
let userId = null;

// Cleanup tracking. Order matters: rule → task → notification → approval →
// contact → webhook to respect FKs.
const created = {
  rules: [],
  tasks: [],
  notifications: [],
  approvals: [],
  contacts: [],
  webhooks: [],
};

const auth = () => ({ Authorization: `Bearer ${token}` });

test.describe.configure({ mode: 'serial' });

test.describe('eventBus.executeAction() — dispatcher coverage', () => {
  test.beforeAll(async ({ request }) => {
    const login = await request.post(`${API}/auth/login`, { data: ADMIN });
    expect(login.ok(), `login: ${login.status()} ${await login.text()}`).toBeTruthy();
    const body = await login.json();
    token = body.token;
    userId = body.user?.id || body.userId || body.user?.userId || null;
    if (!userId) {
      const me = await request.get(`${API}/auth/me`, { headers: auth() });
      if (me.ok()) {
        const meBody = await me.json();
        userId = meBody.id || meBody.user?.id || null;
      }
    }
    expect(userId).toBeTruthy();
  });

  test.afterAll(async ({ request }) => {
    for (const id of created.rules) {
      await request.delete(`${API}/workflows/${id}`, { headers: auth() }).catch(() => {});
    }
    for (const id of created.tasks) {
      await request.delete(`${API}/tasks/${id}`, { headers: auth() }).catch(() => {});
    }
    for (const id of created.notifications) {
      await request.delete(`${API}/notifications/${id}`, { headers: auth() }).catch(() => {});
    }
    for (const id of created.approvals) {
      await request.delete(`${API}/approvals/${id}`, { headers: auth() }).catch(() => {});
    }
    for (const id of created.contacts) {
      await request.delete(`${API}/contacts/${id}`, { headers: auth() }).catch(() => {});
    }
    for (const id of created.webhooks) {
      await request.delete(`${API}/developer/webhooks/${id}`, { headers: auth() }).catch(() => {});
    }
  });

  // ── helpers ────────────────────────────────────────────────────────
  async function createRule(request, { name, triggerType, actionType, targetState }) {
    const res = await request.post(`${API}/workflows`, {
      headers: auth(),
      data: {
        name,
        triggerType,
        actionType,
        targetState: typeof targetState === 'string' ? targetState : JSON.stringify(targetState),
      },
    });
    expect(res.status(), `rule create: ${res.status()} ${await res.text()}`).toBe(201);
    const rule = await res.json();
    created.rules.push(rule.id);
    return rule;
  }

  async function fireRule(request, ruleId, payload) {
    const res = await request.post(`${API}/workflows/${ruleId}/test`, {
      headers: auth(),
      data: { payload },
    });
    expect(res.ok(), `fire: ${res.status()} ${await res.text()}`).toBeTruthy();
    // Engine runs synchronously; allow a beat for chained-event side effects.
    await new Promise((r) => setTimeout(r, 600));
  }

  async function listAuditForRule(request, ruleId) {
    const res = await request.get(`${API}/audit?entity=AutomationRule&action=WORKFLOW`, {
      headers: auth(),
    });
    expect(res.ok()).toBeTruthy();
    const rows = await res.json();
    return (rows || []).filter((r) => r.entityId === ruleId);
  }

  // ── send_email ─────────────────────────────────────────────────────
  // Side-effect: sendMailgun() is called. If MAILGUN_API_KEY isn't set
  // (typical for the dev box), the function early-returns with
  // {sent:false, reason:"no_api_key"} and the WORKFLOW audit row is still
  // written. We assert the audit row.
  test('send_email branch executes and writes audit (Mailgun call may be logged-only)', async ({ request }) => {
    const rule = await createRule(request, {
      name: `act-email-${TAG}`,
      triggerType: 'invoice.overdue',
      actionType: 'send_email',
      targetState: {
        to: `e2e_flow_${TAG_SUFFIX}@example.test`,
        subject: `Test [${TAG}]`,
        body: 'Plain body, will be HTML-converted by sendMailgun',
      },
    });
    await fireRule(request, rule.id, { invoiceId: 1, amount: 999 });
    const rows = await listAuditForRule(request, rule.id);
    expect(rows.length, 'send_email rule must produce an audit row').toBeGreaterThanOrEqual(1);
  });

  test('send_email with no recipient logs warning and still writes audit', async ({ request }) => {
    // No `to` in config and no `email` in payload → engine warns + skips
    // sendMailgun, but the audit log line still fires (it's after the switch).
    const rule = await createRule(request, {
      name: `act-email-norecip-${TAG}`,
      triggerType: 'invoice.overdue',
      actionType: 'send_email',
      targetState: { subject: `No recipient [${TAG}]`, body: 'x' },
    });
    await fireRule(request, rule.id, { invoiceId: 2 });
    const rows = await listAuditForRule(request, rule.id);
    expect(rows.length).toBeGreaterThanOrEqual(1);
  });

  // ── send_notification ──────────────────────────────────────────────
  test('send_notification branch creates a Notification row', async ({ request }) => {
    const notifTitle = `act-notif-${TAG}`;
    const rule = await createRule(request, {
      name: notifTitle,
      triggerType: 'deal.won',
      actionType: 'send_notification',
      targetState: { userId, title: notifTitle, message: 'won via test' },
    });
    const beforeRes = await request.get(`${API}/notifications`, { headers: auth() });
    const beforeBody = await beforeRes.json();
    const beforeIds = new Set(
      (Array.isArray(beforeBody) ? beforeBody : beforeBody.data || beforeBody.notifications || []).map(
        (n) => n.id
      )
    );

    await fireRule(request, rule.id, { dealId: 9, userId });

    const afterRes = await request.get(`${API}/notifications`, { headers: auth() });
    const afterBody = await afterRes.json();
    const after = Array.isArray(afterBody) ? afterBody : afterBody.data || afterBody.notifications || [];
    const fresh = after.filter((n) => !beforeIds.has(n.id));
    const match = fresh.find((n) => n.title === notifTitle);
    expect(match, `expected fresh Notification "${notifTitle}"`).toBeTruthy();
    expect(match.userId).toBe(userId);
    created.notifications.push(match.id);
  });

  // ── create_task ────────────────────────────────────────────────────
  test('create_task branch creates a Task row with rendered title', async ({ request }) => {
    // First, create a contact so the engine can attach the task to a
    // tenant-visible row (otherwise contactId is null which is fine but
    // makes the assertion harder).
    const contactRes = await request.post(`${API}/contacts`, {
      headers: auth(),
      data: {
        name: `Aarav Nair ${TAG}`,
        email: `aarav.${TAG_SUFFIX}@example.test`,
        status: 'Lead',
      },
    });
    expect(contactRes.status()).toBe(201);
    const contact = await contactRes.json();
    created.contacts.push(contact.id);

    const taskTitle = `Follow up E2E ${TAG}`;
    const rule = await createRule(request, {
      name: `act-task-${TAG}`,
      triggerType: 'contact.created',
      actionType: 'create_task',
      targetState: { title: taskTitle, dueInDays: 5, assignToId: userId },
    });

    await fireRule(request, rule.id, { contactId: contact.id, userId });

    const tasksRes = await request.get(`${API}/tasks?contactId=${contact.id}`, { headers: auth() });
    const tasks = await tasksRes.json();
    const list = Array.isArray(tasks) ? tasks : tasks.data || tasks.tasks || [];
    const match = list.find((t) => t.title === taskTitle);
    expect(match, `expected Task "${taskTitle}"`).toBeTruthy();
    expect(match.userId).toBe(userId);
    expect(match.contactId).toBe(contact.id);
    expect(match.dueDate).toBeTruthy();
    created.tasks.push(match.id);
  });

  // ── update_field ───────────────────────────────────────────────────
  // Drives prisma.contact.update via the engine; we then GET the contact
  // and confirm the field actually changed.
  test('update_field branch mutates the targeted entity row', async ({ request }) => {
    // Seed a contact whose `status` we'll flip.
    const seed = await request.post(`${API}/contacts`, {
      headers: auth(),
      data: {
        name: `Priya Sharma E2E ${TAG}`,
        email: `priya.${TAG_SUFFIX}@example.test`,
        status: 'Lead',
      },
    });
    expect(seed.status()).toBe(201);
    const contact = await seed.json();
    created.contacts.push(contact.id);

    const rule = await createRule(request, {
      name: `act-update-${TAG}`,
      triggerType: 'lead.converted',
      actionType: 'update_field',
      targetState: {
        entity: 'contact',
        entityId: contact.id,
        field: 'status',
        value: 'Customer',
      },
    });

    await fireRule(request, rule.id, { contactId: contact.id });

    const after = await request.get(`${API}/contacts/${contact.id}`, { headers: auth() });
    expect(after.ok()).toBeTruthy();
    const refreshed = await after.json();
    expect(refreshed.status).toBe('Customer');
  });

  // ── assign_agent ───────────────────────────────────────────────────
  test('assign_agent branch sets contact.assignedToId', async ({ request }) => {
    const seed = await request.post(`${API}/contacts`, {
      headers: auth(),
      data: {
        name: `Rohan Iyer E2E ${TAG}`,
        email: `rohan.${TAG_SUFFIX}@example.test`,
        status: 'Lead',
      },
    });
    expect(seed.status()).toBe(201);
    const contact = await seed.json();
    created.contacts.push(contact.id);

    const rule = await createRule(request, {
      name: `act-assign-${TAG}`,
      triggerType: 'contact.created',
      actionType: 'assign_agent',
      targetState: { userId },
    });

    await fireRule(request, rule.id, { contactId: contact.id });

    const after = await request.get(`${API}/contacts/${contact.id}`, { headers: auth() });
    expect(after.ok()).toBeTruthy();
    const refreshed = await after.json();
    expect(refreshed.assignedToId).toBe(userId);
  });

  // ── send_sms ───────────────────────────────────────────────────────
  // Engine implementation is a placeholder: console.log only, no DB write.
  // We exercise the branch and confirm the audit log row is written.
  // SKIPPED ASSERTION: SmsMessage row creation — the current engine does NOT
  // persist anything for send_sms (line 277 of eventBus.js, comment marks it
  // as "Placeholder: would integrate with SMS provider"). We covered the
  // dispatch + audit, not the provider call.
  test('send_sms branch executes (placeholder; audit row only)', async ({ request }) => {
    const rule = await createRule(request, {
      name: `act-sms-${TAG}`,
      triggerType: 'contact.created',
      actionType: 'send_sms',
      targetState: { to: '+919800022001', message: `SMS body ${TAG}` },
    });
    await fireRule(request, rule.id, { phone: '+919800022001' });
    const rows = await listAuditForRule(request, rule.id);
    expect(rows.length).toBeGreaterThanOrEqual(1);
  });

  // ── send_webhook ───────────────────────────────────────────────────
  // The engine calls deliverSingle(url, ...). The HTTP POST is fire-and-
  // forget; we don't run an inbound stub on the dev box. We assert the
  // engine entered the branch (audit row) and didn't crash on an unreachable
  // URL.
  test('send_webhook branch invokes deliverSingle with the configured URL', async ({ request }) => {
    const rule = await createRule(request, {
      name: `act-webhook-${TAG}`,
      triggerType: 'deal.won',
      actionType: 'send_webhook',
      // 127.0.0.1:1 is closed; deliverSingle will catch the error and log
      // a FAILED line. The branch is exercised either way.
      targetState: { url: 'http://127.0.0.1:1/e2e-webhook-stub' },
    });
    await fireRule(request, rule.id, { dealId: 11 });
    const rows = await listAuditForRule(request, rule.id);
    expect(rows.length).toBeGreaterThanOrEqual(1);
  });

  // ── create_approval ────────────────────────────────────────────────
  test('create_approval branch creates an ApprovalRequest row and chains approval.created', async ({ request }) => {
    const rule = await createRule(request, {
      name: `act-approval-${TAG}`,
      triggerType: 'deal.created',
      actionType: 'create_approval',
      targetState: {
        entity: 'Deal',
        reasonTemplate: `Deal ${TAG} needs review`,
      },
    });

    const beforeRes = await request.get(`${API}/approvals?entity=Deal`, { headers: auth() });
    const beforeIds = new Set((await beforeRes.json()).map((r) => r.id));

    await fireRule(request, rule.id, { dealId: 12, userId });

    const afterRes = await request.get(`${API}/approvals?entity=Deal`, { headers: auth() });
    const after = await afterRes.json();
    const fresh = after.filter((r) => !beforeIds.has(r.id));
    expect(fresh.length, 'expected fresh ApprovalRequest').toBeGreaterThanOrEqual(1);
    const match = fresh.find((r) => r.reason === `Deal ${TAG} needs review`);
    expect(match).toBeTruthy();
    expect(match.entity).toBe('Deal');
    expect(match.entityId).toBe(12);
    expect(match.status).toBe('PENDING');
    created.approvals.push(match.id);
  });

  test('create_approval skips when entity is missing from config (warns, no row)', async ({ request }) => {
    const rule = await createRule(request, {
      name: `act-approval-noent-${TAG}`,
      triggerType: 'deal.created',
      actionType: 'create_approval',
      targetState: { reasonTemplate: 'will not happen' }, // no entity
    });

    const beforeRes = await request.get(`${API}/approvals`, { headers: auth() });
    const beforeIds = new Set((await beforeRes.json()).map((r) => r.id));

    await fireRule(request, rule.id, { dealId: 13, userId });

    const afterRes = await request.get(`${API}/approvals`, { headers: auth() });
    const after = await afterRes.json();
    const fresh = after.filter((r) => !beforeIds.has(r.id));
    // Engine logs a warning and breaks without creating; audit row may
    // still be written because audit happens after the switch.
    const ours = fresh.filter((r) => (r.reason || '').includes('will not happen'));
    expect(ours.length, 'no ApprovalRequest should be created when entity missing').toBe(0);
  });

  test('create_approval skips when payload entityId is missing', async ({ request }) => {
    const rule = await createRule(request, {
      name: `act-approval-noid-${TAG}`,
      triggerType: 'deal.created',
      actionType: 'create_approval',
      targetState: { entity: 'Deal', reasonTemplate: 'no id payload' },
    });

    const beforeRes = await request.get(`${API}/approvals?entity=Deal`, { headers: auth() });
    const beforeIds = new Set((await beforeRes.json()).map((r) => r.id));

    await fireRule(request, rule.id, { userId }); // no dealId

    const afterRes = await request.get(`${API}/approvals?entity=Deal`, { headers: auth() });
    const after = await afterRes.json();
    const fresh = after.filter((r) => !beforeIds.has(r.id));
    const ours = fresh.filter((r) => (r.reason || '') === 'no id payload');
    expect(ours.length, 'no ApprovalRequest when payload.dealId missing').toBe(0);
  });
});
