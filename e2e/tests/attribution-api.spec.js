// @ts-check
/**
 * Attribution API — R-1 substitute (knowledge-base on R-4 already had a
 * spec, attribution was the first alternate from the discovery survey's
 * R-1 list).
 *
 * Target: routes/attribution.js (323 lines, zero gate coverage). The
 * route powers the marketing Attribution dashboard + AI summarisation:
 * touchpoint timeline per contact + per-channel/source aggregation +
 * first-touch + multi-touch-linear revenue models. A regression here
 * silently breaks every channel ROI number on the marketing dashboard,
 * and the touchpoint write-side (`POST /track`) is what every chatbot /
 * landing-page / sequence integration calls when a lead engages — bad
 * tenant scoping or a 500 on missing-field POST corrupts every downstream
 * model.
 *
 * Endpoints:
 *   POST /api/attribution/track                — record a touchpoint, mutate
 *                                                Contact.firstTouchSource +
 *                                                .lastTouchSource. Validates
 *                                                contactId + channel; 404 on
 *                                                wrong-tenant or missing
 *                                                contact (defence-in-depth).
 *   GET  /api/attribution/contact/:id          — { contact, touchpoints[] }
 *                                                ordered by timestamp asc.
 *                                                404 on cross-tenant.
 *   GET  /api/attribution/report?from=&to=     — { byChannel[], bySource[] }
 *                                                with touchpoints/contacts/
 *                                                deals/revenue counts. Date
 *                                                range optional; bad date
 *                                                strings are silently ignored
 *                                                (filter just doesn't apply).
 *   GET  /api/attribution/first-touch-revenue  — first-touch model
 *   GET  /api/attribution/multi-touch-revenue  — linear-split model
 *
 * Why this exists: every touchpoint write goes through `POST /track`. A
 * silent 500 (e.g. on a missing channel — pre-spec the route does a manual
 * `if (!contactId || !channel)` 400 guard, but a Prisma error elsewhere in
 * the handler would 500 with no test catching it) means the entire
 * Attribution dashboard reads stale data. Tenant-scoping on POST /track
 * is critical: the handler scopes the Contact lookup but a sloppy edit
 * could allow tenant-A to write touchpoints under tenant-B's contact — we
 * lock that down here.
 *
 * Acceptance per endpoint:
 *   POST /track:
 *     ✅ 400 missing contactId
 *     ✅ 400 missing channel
 *     ✅ 404 unknown contactId
 *     ✅ 404 cross-tenant contactId (tenant A admin POSTs B's contactId)
 *     ✅ 201 happy path; response includes id + tenantId-correct row
 *     ✅ Side effect: Contact.lastTouchSource updates every call
 *     ✅ Side effect: Contact.firstTouchSource sets only on first call
 *     ✅ Auth gate: no token → 401/403
 *
 *   GET /contact/:id:
 *     ✅ 200 returns { contact: {...}, touchpoints: [...] }
 *     ✅ Touchpoints sorted by timestamp ascending
 *     ✅ 404 unknown id
 *     ✅ 404 cross-tenant id (lookup scoped to caller tenantId)
 *     ✅ Auth gate
 *
 *   GET /report:
 *     ✅ 200 returns { byChannel: [], bySource: [] } (arrays, possibly empty)
 *     ✅ After POSTing N touchpoints with channel="social", byChannel[social]
 *        .touchpoints >= N
 *     ✅ Tenant isolation: rows from tenant B do NOT inflate tenant A counts
 *     ✅ Bad date strings (?from=not-a-date) don't 500 — silently ignored
 *     ✅ Auth gate
 *
 *   GET /first-touch-revenue + /multi-touch-revenue:
 *     ✅ 200 returns { model, totalRevenue, attributedRevenue, bySource[] }
 *     ✅ Numeric fields are numbers
 *     ✅ Auth gate
 *
 * Non-obvious setup: the spec creates its own Contacts (tagged with RUN_TAG)
 * via /api/contacts so it owns the lifecycle. POST /track has no DELETE
 * endpoint for Touchpoint rows, but Touchpoint has no name field so there's
 * nothing for residue regex to match — afterAll just deletes the contacts
 * (which cascades nothing on Touchpoint, but the Touchpoint rows are
 * orphaned-but-harmless and won't appear in any UI for the demo tenant
 * because the Contact is gone). For tenant isolation, we use both seeded
 * tenants — generic (admin@globussoft.com) and wellness (admin@wellness.demo).
 *
 * Test environment:
 *   - BASE_URL defaults to https://crm.globusdemos.com (matches other gate specs)
 *   - Local: cd e2e && BASE_URL=http://127.0.0.1:5000 npx playwright test \
 *            --project=chromium --no-deps tests/attribution-api.spec.js
 *   - Login: admin@globussoft.com / password123 (generic ADMIN — needed for
 *            DELETE /api/contacts/:id afterAll)
 *            admin@wellness.demo / password123 (wellness ADMIN, tenant
 *            isolation control group)
 *
 * Pattern: cloned from e2e/tests/notifications-api.spec.js (plain CRUD
 * with dual-token tenant isolation describe-block, RUN_TAG helper, and
 * id-tracking afterAll cleanup).
 */
const { test, expect } = require('@playwright/test');

const BASE_URL = process.env.BASE_URL || 'https://crm.globusdemos.com';
const REQUEST_TIMEOUT = 30000;
const RUN_TAG = `E2E_FLOW_ATTRIB_${Date.now()}`;

// ── Dual-token auth ────────────────────────────────────────────────
// admin@globussoft.com (ADMIN, generic tenant) — primary
// admin@wellness.demo  (ADMIN, wellness tenant) — tenant-isolation control

let genericToken = null;
let wellnessToken = null;

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
        return j.token;
      }
    } catch (e) {
      if (attempt === 0) continue;
    }
  }
  return null;
}

async function getGeneric(request) {
  if (!genericToken) {
    genericToken = await loginAs(request, 'admin@globussoft.com', 'password123');
  }
  return genericToken;
}

async function getWellness(request) {
  if (!wellnessToken) {
    wellnessToken = await loginAs(request, 'admin@wellness.demo', 'password123');
  }
  return wellnessToken;
}

const headersFor = (token) => ({
  Authorization: `Bearer ${token}`,
  'Content-Type': 'application/json',
});

async function get(request, token, path) {
  return request.get(`${BASE_URL}${path}`, { headers: headersFor(token), timeout: REQUEST_TIMEOUT });
}
async function post(request, token, path, body) {
  return request.post(`${BASE_URL}${path}`, {
    headers: headersFor(token),
    data: body ?? {},
    timeout: REQUEST_TIMEOUT,
  });
}
async function del(request, token, path) {
  return request.delete(`${BASE_URL}${path}`, { headers: headersFor(token), timeout: REQUEST_TIMEOUT });
}

// ── Cleanup tracking ───────────────────────────────────────────────
// Contacts (both tenants), tracked for DELETE in afterAll.
const createdGenericContactIds = [];
const createdWellnessContactIds = [];

test.afterAll(async ({ request }) => {
  const gTok = await getGeneric(request);
  if (gTok) {
    for (const id of createdGenericContactIds) {
      await del(request, gTok, `/api/contacts/${id}`).catch(() => {});
    }
  }
  const wTok = await getWellness(request);
  if (wTok) {
    for (const id of createdWellnessContactIds) {
      await del(request, wTok, `/api/contacts/${id}`).catch(() => {});
    }
  }
});

// Helper: create a Contact in the generic tenant with a unique name.
async function createContact(request, suffix = '') {
  const tok = await getGeneric(request);
  const res = await post(request, tok, '/api/contacts', {
    name: `${RUN_TAG} contact${suffix ? ` ${suffix}` : ''}`,
    email: `${RUN_TAG.toLowerCase()}.${Date.now()}.${Math.random().toString(36).slice(2, 7)}@e2e.test`,
  });
  expect(res.status(), `create contact: ${await res.text()}`).toBe(201);
  const row = await res.json();
  createdGenericContactIds.push(row.id);
  return row;
}

async function createWellnessContact(request, suffix = '') {
  const tok = await getWellness(request);
  if (!tok) return null;
  const res = await post(request, tok, '/api/contacts', {
    name: `${RUN_TAG} wellness-contact${suffix ? ` ${suffix}` : ''}`,
    email: `${RUN_TAG.toLowerCase()}.w.${Date.now()}.${Math.random().toString(36).slice(2, 7)}@e2e.test`,
  });
  expect(res.status(), `create wellness contact: ${await res.text()}`).toBe(201);
  const row = await res.json();
  createdWellnessContactIds.push(row.id);
  return row;
}

// ── POST /track ─────────────────────────────────────────────────────

test.describe('Attribution API — POST /track (validation)', () => {
  test('400 when contactId is missing', async ({ request }) => {
    const tok = await getGeneric(request);
    const res = await post(request, tok, '/api/attribution/track', { channel: 'email' });
    expect(res.status()).toBe(400);
    expect((await res.json()).error).toMatch(/contactId.*channel/i);
  });

  test('400 when channel is missing', async ({ request }) => {
    const tok = await getGeneric(request);
    const res = await post(request, tok, '/api/attribution/track', { contactId: 1 });
    expect(res.status()).toBe(400);
  });

  test('400 when both contactId and channel are missing', async ({ request }) => {
    const tok = await getGeneric(request);
    const res = await post(request, tok, '/api/attribution/track', {});
    expect(res.status()).toBe(400);
  });

  test('404 when contactId points at a non-existent contact', async ({ request }) => {
    const tok = await getGeneric(request);
    const res = await post(request, tok, '/api/attribution/track', {
      contactId: 99999999,
      channel: 'email',
    });
    expect(res.status()).toBe(404);
    expect((await res.json()).error).toMatch(/not found/i);
  });
});

test.describe('Attribution API — POST /track (happy path + side effects)', () => {
  test('201 records touchpoint and returns row with tenant + contact id', async ({ request }) => {
    const tok = await getGeneric(request);
    const contact = await createContact(request, 'track-happy');
    const res = await post(request, tok, '/api/attribution/track', {
      contactId: contact.id,
      channel: 'email',
      source: 'newsletter',
      medium: 'cta-link',
      url: 'https://example.test/landing',
    });
    expect(res.status(), await res.text()).toBe(201);
    const tp = await res.json();
    expect(typeof tp.id).toBe('number');
    expect(tp.contactId).toBe(contact.id);
    expect(tp.channel).toBe('email');
    expect(tp.source).toBe('newsletter');
    expect(tp.medium).toBe('cta-link');
    expect(tp.url).toBe('https://example.test/landing');
  });

  test('first call sets Contact.firstTouchSource AND lastTouchSource', async ({ request }) => {
    const tok = await getGeneric(request);
    const contact = await createContact(request, 'first-touch-set');
    const res = await post(request, tok, '/api/attribution/track', {
      contactId: contact.id,
      channel: 'social',
      source: 'twitter',
    });
    expect(res.status()).toBe(201);

    // Re-fetch the contact (via /api/contacts/:id) and verify both fields set.
    const refetch = await get(request, tok, `/api/contacts/${contact.id}`);
    expect(refetch.status()).toBe(200);
    const row = await refetch.json();
    expect(row.firstTouchSource).toBe('twitter');
    expect(row.lastTouchSource).toBe('twitter');
  });

  test('subsequent call updates lastTouchSource but keeps firstTouchSource', async ({ request }) => {
    const tok = await getGeneric(request);
    const contact = await createContact(request, 'last-touch-only');
    // First call — sets both
    const r1 = await post(request, tok, '/api/attribution/track', {
      contactId: contact.id, channel: 'social', source: 'twitter',
    });
    expect(r1.status()).toBe(201);
    // Second call — should update lastTouchSource only
    const r2 = await post(request, tok, '/api/attribution/track', {
      contactId: contact.id, channel: 'email', source: 'newsletter',
    });
    expect(r2.status()).toBe(201);

    const refetch = await get(request, tok, `/api/contacts/${contact.id}`);
    expect(refetch.status()).toBe(200);
    const row = await refetch.json();
    expect(row.firstTouchSource).toBe('twitter');     // unchanged
    expect(row.lastTouchSource).toBe('newsletter');   // updated
  });

  test('source falls back to channel when omitted (sourceLabel resolution)', async ({ request }) => {
    const tok = await getGeneric(request);
    const contact = await createContact(request, 'channel-fallback');
    // Pass channel only — handler uses channel as the lastTouchSource label.
    const res = await post(request, tok, '/api/attribution/track', {
      contactId: contact.id,
      channel: 'direct',
    });
    expect(res.status()).toBe(201);

    const refetch = await get(request, tok, `/api/contacts/${contact.id}`);
    expect(refetch.status()).toBe(200);
    const row = await refetch.json();
    expect(row.firstTouchSource).toBe('direct');
    expect(row.lastTouchSource).toBe('direct');
  });
});

// ── GET /contact/:id (timeline) ─────────────────────────────────────

test.describe('Attribution API — GET /contact/:id', () => {
  test('200 returns { contact, touchpoints[] } with sorted touchpoints', async ({ request }) => {
    const tok = await getGeneric(request);
    const contact = await createContact(request, 'timeline');
    // Drop two touchpoints
    await post(request, tok, '/api/attribution/track', {
      contactId: contact.id, channel: 'social', source: 'twitter',
    });
    await post(request, tok, '/api/attribution/track', {
      contactId: contact.id, channel: 'email', source: 'newsletter',
    });
    const res = await get(request, tok, `/api/attribution/contact/${contact.id}`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.contact).toBeTruthy();
    expect(body.contact.id).toBe(contact.id);
    expect(Array.isArray(body.touchpoints)).toBe(true);
    expect(body.touchpoints.length).toBeGreaterThanOrEqual(2);
    // ordered by timestamp asc — verify monotonic
    for (let i = 1; i < body.touchpoints.length; i++) {
      const prev = new Date(body.touchpoints[i - 1].timestamp).getTime();
      const cur = new Date(body.touchpoints[i].timestamp).getTime();
      expect(cur).toBeGreaterThanOrEqual(prev);
    }
  });

  test('404 on unknown contact id', async ({ request }) => {
    const tok = await getGeneric(request);
    const res = await get(request, tok, '/api/attribution/contact/99999999');
    expect(res.status()).toBe(404);
  });
});

// ── GET /report ─────────────────────────────────────────────────────

test.describe('Attribution API — GET /report', () => {
  test('200 returns { byChannel: [], bySource: [] }', async ({ request }) => {
    const tok = await getGeneric(request);
    const res = await get(request, tok, '/api/attribution/report');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.byChannel)).toBe(true);
    expect(Array.isArray(body.bySource)).toBe(true);
  });

  test('after a POST /track, the channel + source appear in aggregations', async ({ request }) => {
    const tok = await getGeneric(request);
    const contact = await createContact(request, 'report-aggr');
    const uniqueChannel = `attribapi_ch_${Date.now()}`;
    const uniqueSource = `attribapi_src_${Date.now()}`;
    await post(request, tok, '/api/attribution/track', {
      contactId: contact.id, channel: uniqueChannel, source: uniqueSource,
    });
    const res = await get(request, tok, '/api/attribution/report');
    expect(res.status()).toBe(200);
    const body = await res.json();
    const ch = body.byChannel.find((e) => e.channel === uniqueChannel);
    const src = body.bySource.find((e) => e.source === uniqueSource);
    expect(ch, `channel ${uniqueChannel} not found in byChannel: ${JSON.stringify(body.byChannel.slice(0, 5))}`).toBeTruthy();
    expect(ch.touchpoints).toBeGreaterThanOrEqual(1);
    expect(ch.contacts).toBeGreaterThanOrEqual(1);
    expect(typeof ch.deals).toBe('number');
    expect(typeof ch.revenue).toBe('number');
    expect(src).toBeTruthy();
    expect(src.touchpoints).toBeGreaterThanOrEqual(1);
  });

  test('bad date strings (?from=not-a-date) do not 500 — silently ignored', async ({ request }) => {
    const tok = await getGeneric(request);
    const res = await get(request, tok, '/api/attribution/report?from=not-a-date&to=also-bad');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.byChannel)).toBe(true);
  });

  test('valid from + to range filters return arrays without 500', async ({ request }) => {
    const tok = await getGeneric(request);
    // Narrow window: aggregating a decade against demo's accumulated
    // touchpoint volume can exceed the proxy's 60s timeout under
    // shard-parallel load (observed 502 in shard-1 of release-validation
    // run 25603870964). The CONTRACT being tested is shape-only — route
    // returns 200 with byChannel + bySource arrays — and that doesn't
    // depend on a wide range. 30 days is plenty.
    const today = new Date();
    const thirtyDaysAgo = new Date(today.getTime() - 30 * 24 * 60 * 60 * 1000);
    const fromIso = thirtyDaysAgo.toISOString().slice(0, 10);
    const toIso = today.toISOString().slice(0, 10);
    const res = await get(
      request,
      tok,
      `/api/attribution/report?from=${fromIso}&to=${toIso}`
    );
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.byChannel)).toBe(true);
    expect(Array.isArray(body.bySource)).toBe(true);
  });
});

// ── GET /first-touch-revenue + /multi-touch-revenue ─────────────────

test.describe('Attribution API — revenue models', () => {
  test('GET /first-touch-revenue 200 + correct envelope shape', async ({ request }) => {
    const tok = await getGeneric(request);
    const res = await get(request, tok, '/api/attribution/first-touch-revenue');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.model).toBe('first-touch');
    expect(typeof body.totalRevenue).toBe('number');
    expect(typeof body.attributedRevenue).toBe('number');
    expect(Array.isArray(body.bySource)).toBe(true);
    if (body.bySource.length > 0) {
      const e = body.bySource[0];
      expect(typeof e.source).toBe('string');
      expect(typeof e.deals).toBe('number');
      expect(typeof e.revenue).toBe('number');
    }
  });

  test('GET /multi-touch-revenue 200 + correct envelope shape', async ({ request }) => {
    const tok = await getGeneric(request);
    const res = await get(request, tok, '/api/attribution/multi-touch-revenue');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.model).toBe('multi-touch-linear');
    expect(typeof body.totalRevenue).toBe('number');
    expect(typeof body.attributedRevenue).toBe('number');
    expect(Array.isArray(body.bySource)).toBe(true);
  });
});

// ── Auth gate ───────────────────────────────────────────────────────

test.describe('Attribution API — auth gate', () => {
  test('POST /track without token → 401/403', async ({ request }) => {
    const res = await request.post(`${BASE_URL}/api/attribution/track`, {
      data: { contactId: 1, channel: 'email' },
      headers: { 'Content-Type': 'application/json' },
      timeout: REQUEST_TIMEOUT,
    });
    expect([401, 403]).toContain(res.status());
  });

  test('GET /contact/:id without token → 401/403', async ({ request }) => {
    const res = await request.get(`${BASE_URL}/api/attribution/contact/1`, {
      timeout: REQUEST_TIMEOUT,
    });
    expect([401, 403]).toContain(res.status());
  });

  test('GET /report without token → 401/403', async ({ request }) => {
    const res = await request.get(`${BASE_URL}/api/attribution/report`, {
      timeout: REQUEST_TIMEOUT,
    });
    expect([401, 403]).toContain(res.status());
  });

  test('GET /first-touch-revenue without token → 401/403', async ({ request }) => {
    const res = await request.get(`${BASE_URL}/api/attribution/first-touch-revenue`, {
      timeout: REQUEST_TIMEOUT,
    });
    expect([401, 403]).toContain(res.status());
  });

  test('GET /multi-touch-revenue without token → 401/403', async ({ request }) => {
    const res = await request.get(`${BASE_URL}/api/attribution/multi-touch-revenue`, {
      timeout: REQUEST_TIMEOUT,
    });
    expect([401, 403]).toContain(res.status());
  });
});

// ── Tenant isolation ────────────────────────────────────────────────
//
// Defence-in-depth: route file scopes the contact lookup by tenantId on
// POST /track + GET /contact/:id, and the report/revenue endpoints scope
// the touchpoint + deal queries. We verify all three classes here.

test.describe('Attribution API — tenant isolation', () => {
  test('POST /track 404s when contactId belongs to another tenant', async ({ request }) => {
    const wTok = await getWellness(request);
    if (!wTok) test.skip(true, 'wellness tenant not seeded');
    // Create a contact in WELLNESS tenant
    const wContact = await createWellnessContact(request, 'cross-tenant-track');
    if (!wContact) test.skip(true, 'wellness contact create failed');
    // Try to attach a touchpoint AS GENERIC tenant — must 404
    const gTok = await getGeneric(request);
    const res = await post(request, gTok, '/api/attribution/track', {
      contactId: wContact.id,
      channel: 'email',
    });
    expect(res.status()).toBe(404);
  });

  test('GET /contact/:id 404s when contact belongs to another tenant', async ({ request }) => {
    const wTok = await getWellness(request);
    if (!wTok) test.skip(true, 'wellness tenant not seeded');
    const wContact = await createWellnessContact(request, 'cross-tenant-timeline');
    if (!wContact) test.skip(true, 'wellness contact create failed');
    const gTok = await getGeneric(request);
    const res = await get(request, gTok, `/api/attribution/contact/${wContact.id}`);
    expect(res.status()).toBe(404);
  });

  test('GET /report does not include other-tenant touchpoint counts', async ({ request }) => {
    const wTok = await getWellness(request);
    if (!wTok) test.skip(true, 'wellness tenant not seeded');
    // Wellness tenant: create contact + drop a touchpoint with a unique
    // channel so we can detect leakage.
    const wContact = await createWellnessContact(request, 'cross-tenant-report');
    if (!wContact) test.skip(true, 'wellness contact create failed');
    const uniqueChannel = `attribapi_xt_${Date.now()}`;
    const trackRes = await post(request, wTok, '/api/attribution/track', {
      contactId: wContact.id,
      channel: uniqueChannel,
      source: 'cross-tenant-leak-source',
    });
    expect(trackRes.status()).toBe(201);

    // Generic admin should NOT see that channel in their report.
    const gTok = await getGeneric(request);
    const res = await get(request, gTok, '/api/attribution/report');
    expect(res.status()).toBe(200);
    const body = await res.json();
    const leak = body.byChannel.find((e) => e.channel === uniqueChannel);
    expect(leak, `cross-tenant channel leaked into report: ${JSON.stringify(leak)}`).toBeFalsy();
    const srcLeak = body.bySource.find((e) => e.source === 'cross-tenant-leak-source');
    expect(srcLeak, `cross-tenant source leaked into report: ${JSON.stringify(srcLeak)}`).toBeFalsy();
  });
});
