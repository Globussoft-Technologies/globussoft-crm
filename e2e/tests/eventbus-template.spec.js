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

  // Demo-state-divergence note: emitEvent fires EVERY active rule whose
  // triggerType matches `deal.created`, not just our `:id/test` target. On
  // demo (and on a re-used local stack) there are accumulated stale rules
  // bound to `deal.created` from prior runs that didn't reach afterAll
  // cleanup — each one writes its OWN ApprovalRequest with a different
  // rendered reason. The pre-fix `fresh[0]` snapshot-diff lookup picked the
  // newest fresh approval, which on demo turned out to be a STALE rule's
  // output (e.g. "no id payload") instead of ours. Fix: parameterise the
  // lookup on `expectedReason` and match on an exact equality against OUR
  // rule's rendered output. For the empty-template path (reason persisted
  // as null), do a snapshot-diff on the approvals list, scoped to the test's
  // unique dealId, and pick the freshly-created null-reason row.
  async function fireRuleAndFindApproval(request, ruleId, payload, { expectedReason } = {}) {
    // Snapshot existing approval IDs before firing — only used by the
    // null-reason path, but cheap to compute always.
    const beforeRes = await request.get(`${API}/approvals?entity=Deal`, { headers: auth() });
    expect(beforeRes.ok()).toBeTruthy();
    const beforeRows = await beforeRes.json();
    const beforeIds = new Set((beforeRows || []).map((r) => r.id));

    const fire = await request.post(`${API}/workflows/${ruleId}/test`, {
      headers: auth(),
      data: { payload },
    });
    expect(fire.ok(), `fire: ${fire.status()} ${await fire.text()}`).toBeTruthy();

    // create_approval also re-emits "approval.created", so allow a moment for
    // any chained rules (and the actual ApprovalRequest write) to settle.
    await new Promise((r) => setTimeout(r, 600));

    const res = await request.get(`${API}/approvals?entity=Deal`, { headers: auth() });
    expect(res.ok()).toBeTruthy();
    const rows = await res.json();
    let match;
    if (expectedReason !== undefined) {
      // Exact-equality match on the rendered reason (string OR null payloads
      // that still produce a non-null reason via the {{...}} raw passthrough).
      match = (rows || []).find((r) => r.reason === expectedReason);
    } else {
      // Empty-template path → pick the freshly-created null-reason row
      // scoped to OUR dealId. `beforeIds` filters out stale null-reason rows
      // that other tests / stale rules created earlier; the entityId match
      // narrows to our specific fire's payload.
      const dealId = payload.dealId;
      match = (rows || []).find(
        (r) => !beforeIds.has(r.id) && r.reason === null && r.entityId === dealId,
      );
    }
    expect(
      match,
      `expected ApprovalRequest matching ${expectedReason !== undefined ? JSON.stringify(expectedReason) : `null reason for dealId=${payload.dealId}`} in ${rows?.length ?? 0} rows`,
    ).toBeTruthy();
    createdApprovalIds.push(match.id);
    return match;
  }

  // ── 1. Single placeholder, top-level resolution ───────────────────
  test('top-level placeholder resolves from payload', async ({ request }) => {
    const rule = await createApprovalRule(request, {
      name: `tpl-toplevel-${TAG}`,
      reasonTemplate: `Lead {{name}} flagged ${TAG}`,
    });
    const expected = `Lead Aarav Patel flagged ${TAG}`;
    const approval = await fireRuleAndFindApproval(
      request,
      rule.id,
      { dealId: 1, userId, name: 'Aarav Patel' },
      { expectedReason: expected },
    );
    expect(approval.reason).toBe(expected);
  });

  // ── 2. Dot-path resolves nested field ─────────────────────────────
  test('dot-path placeholder resolves nested fields', async ({ request }) => {
    const rule = await createApprovalRule(request, {
      name: `tpl-nested-${TAG}`,
      reasonTemplate: `Lead {{contact.name}} from {{contact.source}} ${TAG}`,
    });
    const expected = `Lead Aarav Patel from google_ads ${TAG}`;
    const approval = await fireRuleAndFindApproval(
      request,
      rule.id,
      { dealId: 2, userId, contact: { name: 'Aarav Patel', source: 'google_ads' } },
      { expectedReason: expected },
    );
    expect(approval.reason).toBe(expected);
  });

  // ── 3. Flat fallback ──────────────────────────────────────────────
  test('flat-fallback resolves the trailing segment when payload is flat', async ({ request }) => {
    const rule = await createApprovalRule(request, {
      name: `tpl-flat-${TAG}`,
      reasonTemplate: `Discount on {{deal.title}} ${TAG}`,
    });
    // Flat payload — emitEvent callers historically flatten the shape.
    const expected = `Discount on Acme Renewal Q4 ${TAG}`;
    const approval = await fireRuleAndFindApproval(
      request,
      rule.id,
      { dealId: 3, userId, title: 'Acme Renewal Q4' },
      { expectedReason: expected },
    );
    expect(approval.reason).toBe(expected);
  });

  // ── 4. Multiple placeholders + extra plain text ───────────────────
  test('multiple placeholders all interpolate', async ({ request }) => {
    const rule = await createApprovalRule(request, {
      name: `tpl-multi-${TAG}`,
      reasonTemplate: `{{name}} requested {{amount}} for {{reason}} ${TAG}`,
    });
    const expected = `Priya requested 50000 for renewal ${TAG}`;
    const approval = await fireRuleAndFindApproval(
      request,
      rule.id,
      { dealId: 4, userId, name: 'Priya', amount: '50000', reason: 'renewal' },
      { expectedReason: expected },
    );
    expect(approval.reason).toBe(expected);
  });

  // ── 5. Unresolved placeholder is left RAW (intentional) ───────────
  test('unresolved placeholder stays as raw {{path}} in the rendered output', async ({ request }) => {
    const rule = await createApprovalRule(request, {
      name: `tpl-unresolved-${TAG}`,
      reasonTemplate: `User: {{name}}, missing: {{nonexistent.field}} ${TAG}`,
    });
    const expected = `User: Aarav, missing: {{nonexistent.field}} ${TAG}`;
    const approval = await fireRuleAndFindApproval(
      request,
      rule.id,
      { dealId: 5, userId, name: 'Aarav' },
      { expectedReason: expected },
    );
    // Raw `{{nonexistent.field}}` MUST be preserved verbatim — the JSDoc
    // contract is "the rule author sees the bug, not silent undefined".
    expect(approval.reason).toBe(expected);
  });

  // ── 6. Whitespace inside {{ }} is trimmed ─────────────────────────
  test('whitespace around the path is trimmed before lookup', async ({ request }) => {
    const rule = await createApprovalRule(request, {
      name: `tpl-whitespace-${TAG}`,
      reasonTemplate: `Hi {{   name   }} ${TAG}`,
    });
    const expected = `Hi Rohan ${TAG}`;
    const approval = await fireRuleAndFindApproval(
      request,
      rule.id,
      { dealId: 6, userId, name: 'Rohan' },
      { expectedReason: expected },
    );
    expect(approval.reason).toBe(expected);
  });

  // ── 7. Empty template ─────────────────────────────────────────────
  // create_approval treats empty reason as null (see eventBus.js line 307:
  // `renderTemplate(config.reasonTemplate || "", payload) || null`).
  // Lookup uses the recent-cutoff null-reason path — see helper above.
  test('empty reasonTemplate yields a null reason on the ApprovalRequest', async ({ request }) => {
    const rule = await createApprovalRule(request, {
      name: `tpl-empty-${TAG}`,
      reasonTemplate: '',
    });
    const approval = await fireRuleAndFindApproval(
      request,
      rule.id,
      { dealId: 7, userId },
      // expectedReason: undefined + reasonContains: undefined → recent null branch.
    );
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
    const expected = `Hi {{name}} ${TAG}`;
    const approval = await fireRuleAndFindApproval(
      request,
      rule.id,
      { dealId: 8, userId, name: null },
      { expectedReason: expected },
    );
    expect(approval.reason).toBe(expected);
  });
});
