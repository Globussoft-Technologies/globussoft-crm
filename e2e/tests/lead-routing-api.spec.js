// @ts-check
/**
 * Lead-routing API gate (P1 task #7).
 *
 * routes/lead_routing.js had no API spec. This locks the contract
 * for the rule-CRUD + apply-all surface. Cluster of 11 issues, of
 * which 8 are testable from API-only fixtures (the other 3 — #320
 * timestamp suffix in rule names is covered by demo-hygiene-api;
 * #333 estimates bounds is unrelated; #370 is a UI dropdown).
 *
 * Issues prevented from regressing:
 *
 *   #245  GET returns parsed `conditions` object, not raw JSON-string
 *         DSL like "status neq india"
 *   #258  POST /apply-all returns a sensible response with numeric
 *         counts (was returning undefined fields)
 *   #299  conditions.status accepts only known enum values (Lead /
 *         Prospect / Customer / Churned / Junk) — case-insensitive
 *   #301  POST/PUT priority < 1 -> 400
 *   #302  POST conditions cannot be empty/null — "any" rules must
 *         be explicit
 *   #332  POST/PUT priority > 999 -> 400
 *   #350  same priority bound, separate user report
 *   #369  /apply-all returns `{ processed, assigned }`-shaped result
 *
 * Out of scope (covered elsewhere):
 *
 *   #320  13-digit timestamp suffixes in rule names — demo-hygiene-api
 *   #333  /estimates Quantity/Price bounds — unrelated to this route
 *   #370  Country select dropdown — frontend UI concern
 */
const { test, expect } = require('@playwright/test');

const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:5000';
const API = `${BASE_URL}/api`;
const REQUEST_TIMEOUT = 60000;

let token = null;
const RUN_TAG = `E2E_LR_${Date.now()}`;
const created = []; // rule ids for cleanup
const createdContacts = []; // contact ids for cleanup (subBrand matching suite)

async function login(request) {
  const r = await request.post(`${API}/auth/login`, {
    data: { email: 'admin@globussoft.com', password: 'password123' },
    headers: { 'Content-Type': 'application/json' },
    timeout: REQUEST_TIMEOUT,
  });
  if (!r.ok()) return null;
  return (await r.json()).token;
}

const auth = (t) => ({ Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' });

async function authGet(request, path) {
  return request.get(`${BASE_URL}${path}`, { headers: { Authorization: `Bearer ${token}` }, timeout: REQUEST_TIMEOUT });
}
async function authPost(request, path, body) {
  return request.post(`${BASE_URL}${path}`, { headers: auth(token), data: body, timeout: REQUEST_TIMEOUT });
}
async function authPut(request, path, body) {
  return request.put(`${BASE_URL}${path}`, { headers: auth(token), data: body, timeout: REQUEST_TIMEOUT });
}
async function authDelete(request, path) {
  return request.delete(`${BASE_URL}${path}`, { headers: { Authorization: `Bearer ${token}` }, timeout: REQUEST_TIMEOUT });
}

test.beforeAll(async ({ request }) => {
  token = await login(request);
});

test.afterAll(async ({ request }) => {
  for (const id of created) {
    await authDelete(request, `/api/lead-routing/${id}`).catch(() => {});
  }
  for (const id of createdContacts) {
    await authDelete(request, `/api/contacts/${id}`).catch(() => {});
  }
});

async function createValidRule(request, overrides = {}) {
  const body = {
    name: `${RUN_TAG} rule`,
    conditions: { status: 'Lead' },
    assignType: 'round_robin',
    priority: 100,
    isActive: true,
    ...overrides,
  };
  const r = await authPost(request, '/api/lead-routing', body);
  expect(r.status(), `create-helper: ${await r.text()}`).toBe(201);
  const rule = await r.json();
  created.push(rule.id);
  return rule;
}

test.describe('Lead-routing API — POST / validation', () => {
  test('rejects missing name with 400', async ({ request }) => {
    test.skip(!token, 'auth unavailable');
    const r = await authPost(request, '/api/lead-routing', { conditions: { status: 'Lead' } });
    expect(r.status()).toBe(400);
  });

  test('#302 rejects null conditions with 400', async ({ request }) => {
    test.skip(!token, 'auth unavailable');
    const r = await authPost(request, '/api/lead-routing', { name: `${RUN_TAG} no-conds`, conditions: null });
    expect(r.status()).toBe(400);
    const body = await r.json();
    expect(body.error).toMatch(/condition/i);
  });

  test('#302 rejects empty conditions object with 400', async ({ request }) => {
    test.skip(!token, 'auth unavailable');
    const r = await authPost(request, '/api/lead-routing', { name: `${RUN_TAG} empty-conds`, conditions: {} });
    expect(r.status()).toBe(400);
    const body = await r.json();
    expect(body.error).toMatch(/condition/i);
  });

  test('#299 rejects unknown conditions.status with 400', async ({ request }) => {
    test.skip(!token, 'auth unavailable');
    const r = await authPost(request, '/api/lead-routing', {
      name: `${RUN_TAG} bad-status`,
      conditions: { status: 'india' },
    });
    expect(r.status()).toBe(400);
    const body = await r.json();
    expect(body.error).toMatch(/invalid status/i);
  });

  test('#299 accepts canonical conditions.status case-insensitively', async ({ request }) => {
    test.skip(!token, 'auth unavailable');
    // "lead" / "Lead" / "LEAD" must all be accepted (validator
    // lowercases before checking the enum). Pre-#299 the route
    // accepted ANY string here.
    for (const v of ['lead', 'Lead', 'LEAD', 'Customer', 'Junk']) {
      const r = await authPost(request, '/api/lead-routing', {
        name: `${RUN_TAG} cs-${v}`,
        conditions: { status: v },
      });
      expect(r.status(), `case-insensitive accept failed for "${v}": ${await r.text()}`).toBe(201);
      created.push((await r.json()).id);
    }
  });

  test('#301 rejects priority = 0 with 400', async ({ request }) => {
    test.skip(!token, 'auth unavailable');
    const r = await authPost(request, '/api/lead-routing', {
      name: `${RUN_TAG} prio-zero`,
      conditions: { status: 'Lead' },
      priority: 0,
    });
    expect(r.status()).toBe(400);
    const body = await r.json();
    expect(body.error).toMatch(/priority/i);
  });

  test('#301 rejects priority = -5 with 400', async ({ request }) => {
    test.skip(!token, 'auth unavailable');
    const r = await authPost(request, '/api/lead-routing', {
      name: `${RUN_TAG} prio-neg`,
      conditions: { status: 'Lead' },
      priority: -5,
    });
    expect(r.status()).toBe(400);
  });

  test('#332 #350 rejects priority = 1000 with 400', async ({ request }) => {
    test.skip(!token, 'auth unavailable');
    const r = await authPost(request, '/api/lead-routing', {
      name: `${RUN_TAG} prio-1000`,
      conditions: { status: 'Lead' },
      priority: 1000,
    });
    expect(r.status()).toBe(400);
  });

  test('#332 #350 rejects priority = 99999 with 400', async ({ request }) => {
    test.skip(!token, 'auth unavailable');
    const r = await authPost(request, '/api/lead-routing', {
      name: `${RUN_TAG} prio-99999`,
      conditions: { status: 'Lead' },
      priority: 99999,
    });
    expect(r.status()).toBe(400);
  });

  test('rejects fractional priority with 400 (must be integer)', async ({ request }) => {
    test.skip(!token, 'auth unavailable');
    const r = await authPost(request, '/api/lead-routing', {
      name: `${RUN_TAG} prio-frac`,
      conditions: { status: 'Lead' },
      priority: 100.5,
    });
    expect(r.status()).toBe(400);
  });

  test('happy path: 201 with parsed conditions object', async ({ request }) => {
    test.skip(!token, 'auth unavailable');
    const rule = await createValidRule(request, { name: `${RUN_TAG} happy` });
    expect(rule.id).toBeGreaterThan(0);
    expect(rule.name).toContain(RUN_TAG);
    expect(rule.priority).toBe(100);
    expect(rule.assignType).toBe('round_robin');
    expect(rule.isActive).toBe(true);
    // #245: conditions in the response must be a parsed object, not
    // a raw JSON string. Pre-fix the route returned the stringified
    // form, which the UI then displayed as "{\"status\":\"Lead\"}".
    expect(typeof rule.conditions, '#245: conditions should be an object, not string').toBe('object');
    expect(rule.conditions.status).toBe('Lead');
  });
});

test.describe('Lead-routing API — GET / list (#245)', () => {
  test('GET / returns array with conditions parsed (not raw string)', async ({ request }) => {
    test.skip(!token, 'auth unavailable');
    await createValidRule(request, { conditions: { status: 'Lead', country: 'India' } });
    const r = await authGet(request, '/api/lead-routing');
    expect(r.status()).toBe(200);
    const rules = await r.json();
    expect(Array.isArray(rules)).toBe(true);
    expect(rules.length).toBeGreaterThan(0);
    // Every rule's conditions must be an object, not a string.
    for (const rule of rules) {
      expect(typeof rule.conditions, `rule ${rule.id} has stringified conditions (#245)`).not.toBe('string');
    }
  });

  test('GET / orders rules by priority asc', async ({ request }) => {
    test.skip(!token, 'auth unavailable');
    const r = await authGet(request, '/api/lead-routing');
    expect(r.status()).toBe(200);
    const rules = await r.json();
    // Walk the list and assert priority is non-decreasing. Real seed
    // may include nulls — skip those and only check ordered pairs.
    for (let i = 1; i < rules.length; i++) {
      const a = rules[i - 1].priority;
      const b = rules[i].priority;
      if (a != null && b != null) {
        expect(b, `rule order broken: ${a} → ${b} at index ${i}`).toBeGreaterThanOrEqual(a);
      }
    }
  });
});

test.describe('Lead-routing API — PUT /:id update', () => {
  test('PUT /:id updates name, leaves other fields intact', async ({ request }) => {
    test.skip(!token, 'auth unavailable');
    const rule = await createValidRule(request, { name: `${RUN_TAG} put-orig` });
    const r = await authPut(request, `/api/lead-routing/${rule.id}`, { name: `${RUN_TAG} put-renamed` });
    expect(r.status()).toBe(200);
    const updated = await r.json();
    expect(updated.name).toContain('put-renamed');
    expect(updated.priority).toBe(100); // unchanged
  });

  test('PUT /:id with priority = 1000 -> 400 (#332/#350)', async ({ request }) => {
    test.skip(!token, 'auth unavailable');
    const rule = await createValidRule(request);
    const r = await authPut(request, `/api/lead-routing/${rule.id}`, { priority: 1000 });
    expect(r.status()).toBe(400);
  });

  test('PUT /:id with bogus status -> 400 (#299)', async ({ request }) => {
    test.skip(!token, 'auth unavailable');
    const rule = await createValidRule(request);
    const r = await authPut(request, `/api/lead-routing/${rule.id}`, { conditions: { status: 'badness' } });
    expect(r.status()).toBe(400);
  });

  test('PUT /:id with isActive only succeeds (partial update)', async ({ request }) => {
    test.skip(!token, 'auth unavailable');
    const rule = await createValidRule(request);
    // Toggling active alone should not require re-validating conditions.
    const r = await authPut(request, `/api/lead-routing/${rule.id}`, { isActive: false });
    expect(r.status()).toBe(200);
    const updated = await r.json();
    expect(updated.isActive).toBe(false);
  });

  test('PUT /9999999 -> 404', async ({ request }) => {
    test.skip(!token, 'auth unavailable');
    const r = await authPut(request, '/api/lead-routing/9999999', { name: 'nope' });
    expect(r.status()).toBe(404);
  });

  test('PUT /:id with non-numeric id -> 400', async ({ request }) => {
    test.skip(!token, 'auth unavailable');
    const r = await authPut(request, '/api/lead-routing/foo', { name: 'nope' });
    expect(r.status()).toBe(400);
  });
});

test.describe('Lead-routing API — DELETE /:id', () => {
  test('DELETE /:id removes the rule', async ({ request }) => {
    test.skip(!token, 'auth unavailable');
    const rule = await createValidRule(request, { name: `${RUN_TAG} delete-me` });
    const r = await authDelete(request, `/api/lead-routing/${rule.id}`);
    expect(r.status()).toBe(200);
    // Verify it's gone.
    const r2 = await authGet(request, '/api/lead-routing');
    const rules = await r2.json();
    const stillThere = rules.find((rr) => rr.id === rule.id);
    expect(stillThere, 'rule should be gone after DELETE').toBeUndefined();
    // Remove from cleanup list (already deleted).
    const idx = created.indexOf(rule.id);
    if (idx >= 0) created.splice(idx, 1);
  });

  test('DELETE /9999999 -> 404', async ({ request }) => {
    test.skip(!token, 'auth unavailable');
    const r = await authDelete(request, '/api/lead-routing/9999999');
    expect(r.status()).toBe(404);
  });
});

test.describe('Lead-routing API — POST /apply-all (#258, #369)', () => {
  test('POST /apply-all returns { processed, assigned } numeric shape', async ({ request }) => {
    test.skip(!token, 'auth unavailable');
    const r = await authPost(request, '/api/lead-routing/apply-all', {});
    expect(r.status()).toBe(200);
    const body = await r.json();
    // #258/#369: response must have numeric counts. Pre-fix returned
    // undefined fields that the UI rendered as "NaN assigned".
    expect(typeof body.processed, '`processed` should be a number').toBe('number');
    expect(typeof body.assigned, '`assigned` should be a number').toBe('number');
    expect(body.assigned).toBeLessThanOrEqual(body.processed);
  });
});

test.describe('Lead-routing API — auth gate', () => {
  test('GET / without token -> 401/403', async ({ request }) => {
    const r = await request.get(`${API}/lead-routing`);
    expect([401, 403]).toContain(r.status());
  });

  test('POST / without token -> 401/403', async ({ request }) => {
    const r = await request.post(`${API}/lead-routing`, {
      data: { name: 'x', conditions: { status: 'Lead' } },
      headers: { 'Content-Type': 'application/json' },
    });
    expect([401, 403]).toContain(r.status());
  });
});

// ── v3.4.11 sanitization regression suite (#398/#447 class) ───────────
//
// Closes the v3.4.10 audit's lead_routing.js finding. Both name and
// conditions are rendered in the /lead-routing admin UI (#245 chip
// display). HTML payloads in either field would land as stored XSS the
// next time an admin views the rule list. routes/lead_routing.js now
// runs sanitizeText on name + sanitizeJsonForStringColumn on conditions
// (both imported from backend/lib/sanitizeJson.js, the v3.4.11 promotion
// of the helpers from routes/sequences.js).
test.describe('Lead-routing API — sanitization (#398/#447 class, v3.4.10 audit)', () => {
  test('POST strips HTML from rule name', async ({ request }) => {
    test.skip(!token, 'auth unavailable');
    const r = await authPost(request, '/api/lead-routing', {
      name: `${RUN_TAG} <img src=x onerror=alert(1)>safe-name`,
      conditions: { status: 'Lead' },
    });
    expect(r.status()).toBe(201);
    const body = await r.json();
    expect(body.name).not.toMatch(/<img/i);
    expect(body.name).not.toMatch(/onerror/i);
    expect(body.name).toContain('safe-name');
  });

  test('POST sanitizes HTML inside non-status condition values (e.g. city contains)', async ({ request }) => {
    test.skip(!token, 'auth unavailable');
    const r = await authPost(request, '/api/lead-routing', {
      name: `${RUN_TAG} city-rule`,
      // Use a non-status field so validateConditions doesn't reject the
      // <script> wrapper as an invalid status (sanitization runs AFTER
      // validation; status validation happens against the raw bytes).
      conditions: { city: { op: 'contains', value: '<script>alert(1)</script>San Francisco' } },
    });
    expect(r.status()).toBe(201);
    const body = await r.json();
    // routes/lead_routing.js GET responses parse the JSON back, so we
    // can assert on the structure directly.
    expect(JSON.stringify(body.conditions)).not.toMatch(/<script/i);
    expect(JSON.stringify(body.conditions)).toContain('San Francisco');
  });

  test('PUT strips HTML from name on partial update', async ({ request }) => {
    test.skip(!token, 'auth unavailable');
    const created = await authPost(request, '/api/lead-routing', {
      name: `${RUN_TAG} put-target`,
      conditions: { status: 'Lead' },
    });
    expect(created.status()).toBe(201);
    const id = (await created.json()).id;
    const r = await request.put(`${API}/lead-routing/${id}`, {
      data: { name: `<a href="javascript:alert(1)">Updated</a>name` },
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    });
    expect(r.status()).toBe(200);
    const body = await r.json();
    expect(body.name).not.toMatch(/<a /i);
    expect(body.name).not.toMatch(/javascript:/i);
    expect(body.name).toContain('Updated');
  });

  test('merge tags ({{firstName}}) survive sanitization in conditions', async ({ request }) => {
    test.skip(!token, 'auth unavailable');
    // Defensive: the codebase elsewhere supports merge-tag preservation
    // (sanitize-html allowedTags:[] only strips <…>-shaped tokens, not
    // {{…}}). Pin that contract holds for lead_routing too.
    const r = await authPost(request, '/api/lead-routing', {
      name: `${RUN_TAG} merge-tag`,
      conditions: { city: { op: 'eq', value: 'Hello {{firstName}} from {{company}}' } },
    });
    expect(r.status()).toBe(201);
    const body = await r.json();
    const condStr = JSON.stringify(body.conditions);
    expect(condStr).toContain('{{firstName}}');
    expect(condStr).toContain('{{company}}');
  });
});

// ── TRAVEL_CRM_PRD §4.1 (gap A8) — subBrand rule condition ─────────────
//
// "Rule-based brand assignment — extend rule schema to filter on subBrand."
// subBrand is a first-class condition key validated against the canonical
// travel sub-brand codes (tmc | rfu | travelstall | visasure — see
// backend/lib/subBrandConfig.js VALID_SUB_BRANDS), persisted in the
// conditions JSON, and honored by the matching engine against
// Contact.subBrand. Rules WITHOUT a subBrand condition keep matching
// everything (backward compatible — pre-travel rules are untouched).
//
// Matching tests create their own contacts with a RUN_TAG-unique `source`
// + status 'Churned' so seeded demo rules (which key on Lead-ish statuses
// and real sources) can't shadow the priority-1 rules created here.
test.describe('Lead-routing API — subBrand condition (PRD §4.1 gap A8)', () => {
  async function createContact(request, overrides = {}) {
    const r = await authPost(request, '/api/contacts', {
      name: `${RUN_TAG} subbrand contact`,
      email: `e2e_lr_subbrand_${Date.now()}_${Math.floor(Math.random() * 1e6)}@example.com`,
      status: 'Churned',
      ...overrides,
    });
    expect(r.status(), `contact-create-helper: ${await r.text()}`).toBe(201);
    const contact = await r.json();
    createdContacts.push(contact.id);
    return contact;
  }

  test('POST accepts a subBrand condition and returns it parsed in conditions', async ({ request }) => {
    test.skip(!token, 'auth unavailable');
    const rule = await createValidRule(request, {
      name: `${RUN_TAG} rfu-brand`,
      conditions: { subBrand: 'rfu' },
    });
    expect(typeof rule.conditions).toBe('object');
    expect(rule.conditions.subBrand).toBe('rfu');
  });

  test('POST rejects an unknown subBrand code with 400', async ({ request }) => {
    test.skip(!token, 'auth unavailable');
    const r = await authPost(request, '/api/lead-routing', {
      name: `${RUN_TAG} bad-brand`,
      conditions: { subBrand: 'acme' },
    });
    expect(r.status()).toBe(400);
    const body = await r.json();
    expect(body.error).toMatch(/invalid subbrand/i);
    expect(body.error).toMatch(/tmc, rfu, travelstall, visasure/);
  });

  test('POST accepts every canonical subBrand code case-insensitively', async ({ request }) => {
    test.skip(!token, 'auth unavailable');
    for (const v of ['tmc', 'RFU', 'travelstall', 'Visasure']) {
      const r = await authPost(request, '/api/lead-routing', {
        name: `${RUN_TAG} brand-${v}`,
        conditions: { subBrand: v },
      });
      expect(r.status(), `subBrand accept failed for "${v}": ${await r.text()}`).toBe(201);
      created.push((await r.json()).id);
    }
  });

  test('apply: rule with subBrand matches a contact carrying the same subBrand', async ({ request }) => {
    test.skip(!token, 'auth unavailable');
    const tag = `${RUN_TAG}_match`;
    const contact = await createContact(request, { source: tag, subBrand: 'rfu' });
    const rule = await createValidRule(request, {
      name: `${RUN_TAG} rfu-match`,
      conditions: { subBrand: 'rfu', source: tag },
      assignType: 'round_robin',
      priority: 1,
    });

    const r = await authPost(request, `/api/lead-routing/apply/${contact.id}`, {});
    expect(r.status()).toBe(200);
    const body = await r.json();
    expect(body.matchedRule, `expected rule ${rule.id} to match: ${JSON.stringify(body)}`).toBeTruthy();
    expect(body.matchedRule.id).toBe(rule.id);
    expect(typeof body.assignedUserId).toBe('number');
  });

  test('apply: rule with subBrand never matches a contact with a DIFFERENT subBrand', async ({ request }) => {
    test.skip(!token, 'auth unavailable');
    const tag = `${RUN_TAG}_mismatch`;
    // Contact is tmc; rule demands visasure — even though `source` matches,
    // the subBrand condition must veto the rule.
    const contact = await createContact(request, { source: tag, subBrand: 'tmc' });
    const rule = await createValidRule(request, {
      name: `${RUN_TAG} visasure-only`,
      conditions: { subBrand: 'visasure', source: tag },
      assignType: 'round_robin',
      priority: 1,
    });

    const r = await authPost(request, `/api/lead-routing/apply/${contact.id}`, {});
    expect(r.status()).toBe(200);
    const body = await r.json();
    // Whatever else happens (another rule may match, or none), OUR
    // sub-brand-mismatched rule must not be the one selected.
    expect(body.matchedRule?.id, 'subBrand-mismatched rule was selected').not.toBe(rule.id);
  });

  test('apply: rule WITHOUT subBrand still matches a sub-branded contact (backward compat)', async ({ request }) => {
    test.skip(!token, 'auth unavailable');
    const tag = `${RUN_TAG}_bc`;
    const contact = await createContact(request, { source: tag, subBrand: 'travelstall' });
    const rule = await createValidRule(request, {
      name: `${RUN_TAG} legacy-no-brand`,
      conditions: { source: tag },
      assignType: 'round_robin',
      priority: 1,
    });

    const r = await authPost(request, `/api/lead-routing/apply/${contact.id}`, {});
    expect(r.status()).toBe(200);
    const body = await r.json();
    expect(body.matchedRule, `expected legacy rule ${rule.id} to match: ${JSON.stringify(body)}`).toBeTruthy();
    expect(body.matchedRule.id).toBe(rule.id);
  });
});

// ── PRD_TRAVEL_MULTICHANNEL_LEADS G007 — first-class channel + subBrand ──
//
// `LeadRoutingRule` carries new TOP-LEVEL columns `channel`, `subBrand`,
// `rrCursor`, `fallbackUserId` (FR-3.3.1). The CRUD surface validates
// channel against the canonical 16-value enum from PRD §3.1.2; subBrand
// reuses the same vocabulary as the JSON-conditions sub-brand
// (lib/subBrandConfig.VALID_SUB_BRANDS); fallbackUserId is a free Int.
// This suite locks the wire contract — the resolver itself (most-
// specific-rule, RR cursor, isAvailable fallback) is covered by the
// vitest under `backend/test/lib/leadAutoRouter.test.js` against
// mocked Prisma; the deploy gate's per-push spec already exercises
// rule CRUD here without a long-running route+DB round-trip per case.
test.describe('Lead-routing API — G007 channel/subBrand/fallbackUserId columns', () => {
  test('POST 201 with channel="whatsapp" + subBrand="rfu" persists lowercased', async ({ request }) => {
    test.skip(!token, 'auth unavailable');
    const r = await authPost(request, '/api/lead-routing', {
      name: `${RUN_TAG} g007-whatsapp-rfu`,
      conditions: { status: 'Lead' },
      channel: 'WhatsApp',
      subBrand: 'RFU',
    });
    expect(r.status(), await r.text()).toBe(201);
    const rule = await r.json();
    created.push(rule.id);
    expect(rule.channel).toBe('whatsapp');
    expect(rule.subBrand).toBe('rfu');
  });

  test('POST 400 rejects unknown channel', async ({ request }) => {
    test.skip(!token, 'auth unavailable');
    const r = await authPost(request, '/api/lead-routing', {
      name: `${RUN_TAG} g007-bad-channel`,
      conditions: { status: 'Lead' },
      channel: 'pigeon',
    });
    expect(r.status()).toBe(400);
    const body = await r.json();
    expect(body.error).toMatch(/invalid channel/i);
  });

  test('PUT 200 clears channel + subBrand to null (wildcard)', async ({ request }) => {
    test.skip(!token, 'auth unavailable');
    const created1 = await createValidRule(request, {
      name: `${RUN_TAG} g007-clear`,
      channel: 'voice',
      subBrand: 'tmc',
    });
    expect(created1.channel).toBe('voice');
    const r = await authPut(request, `/api/lead-routing/${created1.id}`, {
      channel: null,
      subBrand: null,
    });
    expect(r.status()).toBe(200);
    const updated = await r.json();
    expect(updated.channel).toBeNull();
    expect(updated.subBrand).toBeNull();
  });

  test('POST 201 accepts fallbackUserId (Int coerce)', async ({ request }) => {
    test.skip(!token, 'auth unavailable');
    const r = await authPost(request, '/api/lead-routing', {
      name: `${RUN_TAG} g007-fallback`,
      conditions: { status: 'Lead' },
      fallbackUserId: '7',
    });
    expect(r.status()).toBe(201);
    const rule = await r.json();
    created.push(rule.id);
    expect(rule.fallbackUserId).toBe(7);
  });
});

// ── PRD_TRAVEL_MULTICHANNEL_LEADS G008 — User.isAvailable + endpoints ───
//
// PUT /api/users/me/availability — any role can flip their own flag.
// PUT /api/users/:userId/availability — ADMIN/MANAGER can flip another
// user's flag in the same tenant. Cross-tenant + USER-toggling-other
// are gated to 403/401. The actual fallback wiring (round-robin skip
// unavailable user, fall through to fallbackUserId) is covered by the
// router's vitest because exercising it end-to-end requires routing a
// real intake; this suite locks the endpoint contract.
test.describe('User availability — G008 endpoints (FR-3.3.5)', () => {
  test('PUT /me/availability flips the caller`s own isAvailable', async ({ request }) => {
    test.skip(!token, 'auth unavailable');
    // Set false, then back to true so the test is idempotent across reruns.
    const offRes = await authPut(request, '/api/users/me/availability', { isAvailable: false });
    expect(offRes.status(), await offRes.text()).toBe(200);
    const off = await offRes.json();
    expect(off.isAvailable).toBe(false);

    const onRes = await authPut(request, '/api/users/me/availability', { isAvailable: true });
    expect(onRes.status()).toBe(200);
    const on = await onRes.json();
    expect(on.isAvailable).toBe(true);
  });

  test('PUT /me/availability 400 when body.isAvailable missing', async ({ request }) => {
    test.skip(!token, 'auth unavailable');
    const r = await authPut(request, '/api/users/me/availability', {});
    expect(r.status()).toBe(400);
    const body = await r.json();
    expect(body.error).toMatch(/boolean/i);
  });

  test('PUT /me/availability without auth -> 401/403', async ({ request }) => {
    const r = await request.put(`${API}/users/me/availability`, {
      data: { isAvailable: false },
      headers: { 'Content-Type': 'application/json' },
    });
    expect([401, 403]).toContain(r.status());
  });

  test('PUT /:userId/availability 400 on negative id', async ({ request }) => {
    test.skip(!token, 'auth unavailable');
    const r = await authPut(request, '/api/users/-3/availability', { isAvailable: false });
    // Express route param '-3' is captured but our parseInt+isFinite gate rejects.
    expect([400, 404]).toContain(r.status());
  });

  test('PUT /:userId/availability 404 on missing user (large id)', async ({ request }) => {
    test.skip(!token, 'auth unavailable');
    const r = await authPut(request, '/api/users/99999999/availability', { isAvailable: false });
    expect(r.status()).toBe(404);
  });
});
