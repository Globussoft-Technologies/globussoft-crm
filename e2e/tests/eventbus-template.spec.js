// @ts-check
/**
 * eventBus.renderTemplate() coverage.
 *
 * Exercises the mustache-style {{path.to.field}} interpolator used by:
 *   - create_approval.reasonTemplate (the only documented user of renderTemplate)
 *
 * What we cover:
 *   1. Top-level placeholder resolves           — `{{name}}`
 *   2. Dot-path resolves nested field           — `{{contact.name}}`
 *   3. Flat-fallback resolves trailing segment  — `{{contact.name}}` w/ flat payload
 *   4. Multiple placeholders in one string
 *   5. Unresolved placeholder is left RAW in the output (the contract — see
 *      the JSDoc on renderTemplate: "the rule author sees the bug")
 *   6. Whitespace around the path is trimmed     — `{{  name  }}`
 *   7. Null template → empty string             — defensive branch
 *
 * Strategy: create_approval is the only built-in action that runs the user
 * payload through renderTemplate(). We POST a `create_approval` rule with a
 * `reasonTemplate` containing the placeholder under test, fire it via
 * /workflows/:id/test with a payload that resolves (or doesn't), then read
 * back the resulting ApprovalRequest.reason to confirm what the engine
 * actually rendered.
 *
 * Test-data tag: every row created here is suffixed with E2E_FLOW_<6digits>
 * so global-teardown.js scrubs it.
 *
 * Live target:  BASE_URL (default https://crm.globusdemos.com)
 *
 * Backend reference:
 *   backend/lib/eventBus.js          — renderTemplate + lookupField
 *   backend/routes/workflows.js      — /:id/test
 *   backend/routes/approvals.js      — GET / lists ApprovalRequest rows
 */
const { test, expect } = require('@playwright/test');

const BASE_URL = process.env.BASE_URL || 'https://crm.globusdemos.com';
const API = `${BASE_URL}/api`;

const ADMIN = { email: 'admin@globussoft.com', password: 'password123' };

const TAG_SUFFIX = Date.now().toString().slice(-6);
const TAG = `E2E_FLOW_${TAG_SUFFIX}`;

let token = '';
let userId = null;
const createdRuleIds = [];
const createdApprovalIds = [];

const auth = () => ({ Authorization: `Bearer ${token}` });

test.describe.configure({ mode: 'serial' });

test.describe('eventBus.renderTemplate() — mustache interpolation', () => {
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
    for (const id of createdApprovalIds) {
      await request.delete(`${API}/approvals/${id}`, { headers: auth() }).catch(() => {});
    }
    for (const id of createdRuleIds) {
      await request.delete(`${API}/workflows/${id}`, { headers: auth() }).catch(() => {});
    }
  });

  // ── helpers ────────────────────────────────────────────────────────
  async function createApprovalRule(request, { name, reasonTemplate }) {
    const res = await request.post(`${API}/workflows`, {
      headers: auth(),
      data: {
        name,
        triggerType: 'deal.created',
        actionType: 'create_approval',
        targetState: JSON.stringify({
          entity: 'Deal',
          reasonTemplate,
        }),
      },
    });
    expect(res.status(), `rule create failed: ${res.status()} ${await res.text()}`).toBe(201);
    const rule = await res.json();
    createdRuleIds.push(rule.id);
    return rule;
  }

  // Snapshot existing approval IDs so we can spot the one we just created.
  async function listApprovalIds(request) {
    const res = await request.get(`${API}/approvals?entity=Deal`, { headers: auth() });
    expect(res.ok(), `approvals list: ${res.status()}`).toBeTruthy();
    const rows = await res.json();
    return new Set((rows || []).map((r) => r.id));
  }

  async function fireRuleAndFindApproval(request, ruleId, payload) {
    const before = await listApprovalIds(request);
    const fire = await request.post(`${API}/workflows/${ruleId}/test`, {
      headers: auth(),
      data: { payload },
    });
    expect(fire.ok(), `fire: ${fire.status()} ${await fire.text()}`).toBeTruthy();

    // create_approval also re-emits "approval.created", so allow a moment.
    await new Promise((r) => setTimeout(r, 600));

    const res = await request.get(`${API}/approvals?entity=Deal`, { headers: auth() });
    expect(res.ok()).toBeTruthy();
    const rows = await res.json();
    const fresh = (rows || []).filter((r) => !before.has(r.id));
    expect(fresh.length, `expected exactly 1 fresh ApprovalRequest, got ${fresh.length}`).toBeGreaterThanOrEqual(1);
    // Newest first per route ordering — pick the one matching our tagged rule.
    const match = fresh[0];
    createdApprovalIds.push(match.id);
    return match;
  }

  // ── 1. Single placeholder, top-level resolution ───────────────────
  test('top-level placeholder resolves from payload', async ({ request }) => {
    const rule = await createApprovalRule(request, {
      name: `tpl-toplevel-${TAG}`,
      reasonTemplate: `Lead {{name}} flagged ${TAG}`,
    });
    const approval = await fireRuleAndFindApproval(request, rule.id, {
      dealId: 1,
      userId,
      name: 'Aarav Patel',
    });
    expect(approval.reason).toBe(`Lead Aarav Patel flagged ${TAG}`);
  });

  // ── 2. Dot-path resolves nested field ─────────────────────────────
  test('dot-path placeholder resolves nested fields', async ({ request }) => {
    const rule = await createApprovalRule(request, {
      name: `tpl-nested-${TAG}`,
      reasonTemplate: `Lead {{contact.name}} from {{contact.source}} ${TAG}`,
    });
    const approval = await fireRuleAndFindApproval(request, rule.id, {
      dealId: 2,
      userId,
      contact: { name: 'Aarav Patel', source: 'google_ads' },
    });
    expect(approval.reason).toBe(`Lead Aarav Patel from google_ads ${TAG}`);
  });

  // ── 3. Flat fallback ──────────────────────────────────────────────
  test('flat-fallback resolves the trailing segment when payload is flat', async ({ request }) => {
    const rule = await createApprovalRule(request, {
      name: `tpl-flat-${TAG}`,
      reasonTemplate: `Discount on {{deal.title}} ${TAG}`,
    });
    // Flat payload — emitEvent callers historically flatten the shape.
    const approval = await fireRuleAndFindApproval(request, rule.id, {
      dealId: 3,
      userId,
      title: 'Acme Renewal Q4',
    });
    expect(approval.reason).toBe(`Discount on Acme Renewal Q4 ${TAG}`);
  });

  // ── 4. Multiple placeholders + extra plain text ───────────────────
  test('multiple placeholders all interpolate', async ({ request }) => {
    const rule = await createApprovalRule(request, {
      name: `tpl-multi-${TAG}`,
      reasonTemplate: `{{name}} requested {{amount}} for {{reason}} ${TAG}`,
    });
    const approval = await fireRuleAndFindApproval(request, rule.id, {
      dealId: 4,
      userId,
      name: 'Priya',
      amount: '50000',
      reason: 'renewal',
    });
    expect(approval.reason).toBe(`Priya requested 50000 for renewal ${TAG}`);
  });

  // ── 5. Unresolved placeholder is left RAW (intentional) ───────────
  test('unresolved placeholder stays as raw {{path}} in the rendered output', async ({ request }) => {
    const rule = await createApprovalRule(request, {
      name: `tpl-unresolved-${TAG}`,
      reasonTemplate: `User: {{name}}, missing: {{nonexistent.field}} ${TAG}`,
    });
    const approval = await fireRuleAndFindApproval(request, rule.id, {
      dealId: 5,
      userId,
      name: 'Aarav',
    });
    // Raw `{{nonexistent.field}}` MUST be preserved verbatim — the JSDoc
    // contract is "the rule author sees the bug, not silent undefined".
    expect(approval.reason).toBe(`User: Aarav, missing: {{nonexistent.field}} ${TAG}`);
  });

  // ── 6. Whitespace inside {{ }} is trimmed ─────────────────────────
  test('whitespace around the path is trimmed before lookup', async ({ request }) => {
    const rule = await createApprovalRule(request, {
      name: `tpl-whitespace-${TAG}`,
      reasonTemplate: `Hi {{   name   }} ${TAG}`,
    });
    const approval = await fireRuleAndFindApproval(request, rule.id, {
      dealId: 6,
      userId,
      name: 'Rohan',
    });
    expect(approval.reason).toBe(`Hi Rohan ${TAG}`);
  });

  // ── 7. Empty template ─────────────────────────────────────────────
  // create_approval treats empty reason as null (see eventBus.js line 307:
  // `renderTemplate(config.reasonTemplate || "", payload) || null`).
  test('empty reasonTemplate yields a null reason on the ApprovalRequest', async ({ request }) => {
    const rule = await createApprovalRule(request, {
      name: `tpl-empty-${TAG}`,
      reasonTemplate: '',
    });
    const approval = await fireRuleAndFindApproval(request, rule.id, {
      dealId: 7,
      userId,
    });
    expect(approval.reason).toBeNull();
  });

  // ── 8. Null/undefined value in payload leaves placeholder raw ─────
  // lookupField returns undefined for missing keys; renderTemplate's
  // replace callback returns the raw `match` for undefined OR null —
  // so a payload with an explicit null also leaves the placeholder.
  test('explicit null in payload leaves placeholder raw (same as undefined)', async ({ request }) => {
    const rule = await createApprovalRule(request, {
      name: `tpl-null-${TAG}`,
      reasonTemplate: `Hi {{name}} ${TAG}`,
    });
    const approval = await fireRuleAndFindApproval(request, rule.id, {
      dealId: 8,
      userId,
      name: null,
    });
    expect(approval.reason).toBe(`Hi {{name}} ${TAG}`);
  });
});
