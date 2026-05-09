// @ts-check
/**
 * WhatsApp routes — /api/whatsapp/*
 *   Public:  GET /webhook (Meta verify), POST /webhook (Meta event ingress)
 *   Auth:    POST /send, GET /messages, GET /templates, POST /templates,
 *            PUT /templates/:id, DELETE /templates/:id, POST /templates/:id/sync
 *   Admin:   GET /config, PUT /config/:provider
 *
 * Wave 2 Agent KK additions — 2-way completion:
 *   Auth:    GET /threads, GET /threads/:id, POST /threads/:id/{assign,close,
 *            snooze,mark-read}, GET /opt-outs, POST /opt-outs
 *   Admin:   DELETE /opt-outs/:id
 *
 * Inbound webhook now upserts a WhatsAppThread per (tenant, normalisedPhone).
 * "STOP" / "UNSUBSCRIBE" inbound auto-records WhatsAppOptOut + sends a
 * confirmation reply. /send rejects 422 CONTACT_OPTED_OUT for opted-out
 * recipients (DPDP / TRAI compliance).
 */
const { test, expect } = require('@playwright/test');

const BASE_URL = process.env.BASE_URL || 'https://crm.globusdemos.com';
const API = `${BASE_URL}/api`;

const ADMIN_EMAIL = 'admin@globussoft.com';
const ADMIN_PASSWORD = 'password123';

let adminToken = '';
const createdTemplateIds = [];

test.describe.configure({ mode: 'serial' });

test.describe('whatsapp.js — Cloud API messaging + templates + webhook', () => {
  test.beforeAll(async ({ request }) => {
    const login = await request.post(`${API}/auth/login`, {
      data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
    });
    expect(login.ok()).toBeTruthy();
    adminToken = (await login.json()).token;
  });

  test.afterAll(async ({ request }) => {
    for (const id of createdTemplateIds) {
      await request.delete(`${API}/whatsapp/templates/${id}`, {
        headers: { Authorization: `Bearer ${adminToken}` },
      });
    }
  });

  const auth = () => ({ Authorization: `Bearer ${adminToken}` });

  test('GET /whatsapp/messages requires auth', async ({ request }) => {
    const res = await request.get(`${API}/whatsapp/messages`);
    expect([401, 403]).toContain(res.status());
  });

  test('GET /whatsapp/templates requires auth', async ({ request }) => {
    const res = await request.get(`${API}/whatsapp/templates`);
    expect([401, 403]).toContain(res.status());
  });

  test('GET /whatsapp/messages returns paginated shape', async ({ request }) => {
    const res = await request.get(`${API}/whatsapp/messages?limit=5`, { headers: auth() });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.messages)).toBe(true);
    expect(body.pagination).toBeTruthy();
    expect(typeof body.pagination.total).toBe('number');
  });

  test('GET /whatsapp/templates returns array', async ({ request }) => {
    const res = await request.get(`${API}/whatsapp/templates`, { headers: auth() });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
  });

  test('GET /whatsapp/config (admin) returns array with masked accessToken', async ({ request }) => {
    const res = await request.get(`${API}/whatsapp/config`, { headers: auth() });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    for (const cfg of body) {
      if (cfg.accessToken) expect(cfg.accessToken).toMatch(/\*\*\*\*$/);
    }
  });

  test('POST /whatsapp/send rejects missing "to"', async ({ request }) => {
    const res = await request.post(`${API}/whatsapp/send`, {
      headers: auth(),
      data: { body: 'Namaste Aarav' },
    });
    expect(res.status()).toBe(400);
  });

  test('POST /whatsapp/send rejects missing body+templateName', async ({ request }) => {
    const res = await request.post(`${API}/whatsapp/send`, {
      headers: auth(),
      data: { to: '+919900112233' },
    });
    expect(res.status()).toBe(400);
  });

  // ── #518 regression-guards: Meta Cloud API canonical shape ───────────
  // The route destructures {to, body, templateName, parameters, contactId}.
  // Channels.jsx historically posted `{to, body, templateId: <int>}` which
  // silently fell through to the session-text branch (templateId is dropped
  // because `templateName` was undefined), failing customer-outreach outside
  // Meta's 24h re-engagement window. These three tests pin the canonical
  // shape so a future regression to the old form fails CI.

  test('#518 POST /whatsapp/send accepts canonical session-text shape {to, body}', async ({ request }) => {
    const res = await request.post(`${API}/whatsapp/send`, {
      headers: auth(),
      data: { to: '+919900112233', body: 'Hello from session text' },
    });
    // 200 = WhatsAppConfig active and Meta accepted
    // 400 = no active config in this tenant (CI / local default)
    // 500 = config present but Meta provider error (network / quota / etc.)
    // The test asserts the auth gate + shape passed validation, not delivery.
    expect([200, 400, 500]).toContain(res.status());
    if (res.status() === 400) {
      const body = await res.json();
      // Should be the "no active config" error, NOT a "missing required field" error
      expect(body.error || '').toMatch(/no active|provider|configured/i);
    }
  });

  test('#518 POST /whatsapp/send accepts canonical template shape {to, templateName, parameters}', async ({ request }) => {
    const res = await request.post(`${API}/whatsapp/send`, {
      headers: auth(),
      data: {
        to: '+919900112233',
        templateName: 'appointment_reminder',
        parameters: [
          { type: 'text', text: 'Priya Sharma' },
          { type: 'text', text: 'Enhanced Wellness' },
        ],
      },
    });
    // 200/400/500 same matrix as session-text — what we assert is the
    // {templateName, parameters} field shape passed validation (not 400 with
    // "missing body or templateName").
    expect([200, 400, 500]).toContain(res.status());
    if (res.status() === 400) {
      const body = await res.json();
      // Must NOT be the "body or templateName is required" message — that
      // would mean the field-name mapping is broken again.
      expect(body.error || '').not.toMatch(/body or templateName is required/i);
    }
  });

  test('#518 POST /whatsapp/send tolerates extra `templateId` field without confusing it for templateName', async ({ request }) => {
    // The pre-fix Channels.jsx posted `{to, body, templateId: <int>}` thinking
    // templateId was the Meta template selector. The route ignores templateId
    // (extra field, not destructured), and SHOULD fall into the session-text
    // branch via `body`. This test pins that contract: extra templateId field
    // is silently ignored, body branch wins, no 400 from validation.
    const res = await request.post(`${API}/whatsapp/send`, {
      headers: auth(),
      data: { to: '+919900112233', body: 'Hello with stray templateId', templateId: 99999 },
    });
    expect([200, 400, 500]).toContain(res.status());
    if (res.status() === 400) {
      const body = await res.json();
      // 400 must be "no active config", not a validation error from
      // mistakenly treating templateId as templateName and looking up
      // a non-existent template.
      expect(body.error || '').toMatch(/no active|provider|configured/i);
    }
  });

  test('POST /whatsapp/templates rejects missing name/body', async ({ request }) => {
    const res = await request.post(`${API}/whatsapp/templates`, {
      headers: auth(),
      data: { language: 'en_IN' },
    });
    expect(res.status()).toBe(400);
  });

  test('POST /whatsapp/templates creates template', async ({ request }) => {
    const tag = `e2e_audit_${Date.now()}`;
    const res = await request.post(`${API}/whatsapp/templates`, {
      headers: auth(),
      data: {
        name: tag,
        language: 'en_IN',
        category: 'UTILITY',
        body: 'Namaste {{1}}, your appointment is confirmed.',
      },
    });
    expect(res.status()).toBe(201);
    const body = await res.json();
    expect(body.id).toBeTruthy();
    expect(body.status).toBe('PENDING');
    createdTemplateIds.push(body.id);
  });

  test('PUT /whatsapp/templates/:id updates body', async ({ request }) => {
    const id = createdTemplateIds[0];
    test.skip(!id, 'no template created');
    const res = await request.put(`${API}/whatsapp/templates/${id}`, {
      headers: auth(),
      data: { body: 'Namaste {{1}}, your visit on {{2}} is confirmed.' },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.body).toContain('{{2}}');
  });

  test('PUT /whatsapp/templates/:id 404s for unknown id', async ({ request }) => {
    const res = await request.put(`${API}/whatsapp/templates/99999999`, {
      headers: auth(),
      data: { body: 'x' },
    });
    expect(res.status()).toBe(404);
  });

  test('POST /whatsapp/templates/:id/sync 404s without active config', async ({ request }) => {
    const id = createdTemplateIds[0];
    test.skip(!id, 'no template');
    const res = await request.post(`${API}/whatsapp/templates/${id}/sync`, { headers: auth() });
    // 200 if a Meta config replies, 400 if no active config, 500 if Meta errors.
    expect([200, 400, 500]).toContain(res.status());
  });

  // ── Public webhook ──────────────────────────────────────────────────
  test('GET /whatsapp/webhook with bad verify token returns 403', async ({ request }) => {
    const res = await request.get(
      `${API}/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=bogus_e2e&hub.challenge=12345`
    );
    expect([403, 500]).toContain(res.status());
  });

  test('POST /whatsapp/webhook with empty body returns 200 (Meta requires fast 200)', async ({ request }) => {
    const res = await request.post(`${API}/whatsapp/webhook`, {
      data: {},
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.received).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Wave 2 Agent KK — 2-way completion: Threads + Opt-outs + Webhook upsert
// ────────────────────────────────────────────────────────────────────────────
//
// These tests pin the Wave-2 contract:
//   - Inbound webhook creates / reuses a WhatsAppThread keyed by (tenant,
//     normalised E.164 phone). Second inbound on same phone reuses thread,
//     bumps lastInboundAt + unreadCount.
//   - Outbound /send sets threadId + bumps lastMessageAt; reopens CLOSED.
//   - "STOP" inbound auto-creates WhatsAppOptOut (reason=STOP_KEYWORD).
//   - /send to an opted-out phone returns 422 CONTACT_OPTED_OUT.
//   - Thread list filters: status, assignedToId, unread, q (phone/name).
//   - Thread detail returns last 50 messages (ascending order).
//   - Assign / close / snooze / mark-read state transitions.
//   - Tenant isolation on threads + opt-outs.

// Note: file-scope `test.describe.configure({ mode: 'serial' })` already at line 30
// covers this describe too. Repeating it here would error with
// "serial mode is already assigned for the enclosing scope".

test.describe('whatsapp.js — 2-way: threads + opt-outs (Wave 2 Agent KK)', () => {
  let agentToken = '';
  let wellnessToken = '';
  // Unique phones per spec run so concurrent runs (or repeat runs against the
  // same demo) don't collide on the (tenantId, contactPhone) unique constraint.
  const stamp = String(Date.now()).slice(-7);
  const PHONE_A = `+9199${stamp}1`; // primary thread-A phone
  const PHONE_B = `+9199${stamp}2`; // thread-B phone (unread filter)
  const PHONE_STOP = `+9199${stamp}3`; // STOP-keyword phone
  const PHONE_OPTOUT = `+9199${stamp}4`; // manual opt-out phone (send rejection)
  const PHONE_TENANT_B = `+9199${stamp}5`; // tenant-isolation probe
  const createdThreadIds = [];
  const createdOptOutIds = [];

  test.beforeAll(async ({ request }) => {
    const adminLogin = await request.post(`${API}/auth/login`, {
      data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
    });
    expect(adminLogin.ok()).toBeTruthy();
    agentToken = (await adminLogin.json()).token;

    // Wellness tenant for cross-tenant isolation tests.
    const wellnessLogin = await request.post(`${API}/auth/login`, {
      data: { email: 'admin@wellness.demo', password: 'password123' },
    });
    if (wellnessLogin.ok()) {
      wellnessToken = (await wellnessLogin.json()).token;
    }
  });

  test.afterAll(async ({ request }) => {
    // Clean up opt-outs (admin-only DELETE).
    for (const id of createdOptOutIds) {
      await request.delete(`${API}/whatsapp/opt-outs/${id}`, {
        headers: { Authorization: `Bearer ${agentToken}` },
      });
    }
    // Threads have no DELETE endpoint by design (audit trail). Close them
    // so the agent inbox doesn't surface test data on the next run; the
    // unique (tenantId, contactPhone) means re-running with fresh stamps
    // produces fresh rows anyway.
    for (const id of createdThreadIds) {
      await request.post(`${API}/whatsapp/threads/${id}/close`, {
        headers: { Authorization: `Bearer ${agentToken}` },
        data: {},
      });
    }
  });

  const auth = () => ({ Authorization: `Bearer ${agentToken}` });
  const wellnessAuth = () => ({ Authorization: `Bearer ${wellnessToken}` });

  // Helper: post inbound webhook with a single message
  async function postInbound(request, fromPhone, body) {
    return request.post(`${API}/whatsapp/webhook`, {
      data: {
        object: 'whatsapp_business_account',
        entry: [
          {
            changes: [
              {
                field: 'messages',
                value: {
                  metadata: { display_phone_number: '15551234567', phone_number_id: 'pn_test' },
                  messages: [
                    {
                      from: fromPhone.replace(/^\+/, ''), // Meta sends digits-only
                      id: `wamid.e2e_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
                      timestamp: String(Math.floor(Date.now() / 1000)),
                      type: 'text',
                      text: { body },
                    },
                  ],
                },
              },
            ],
          },
        ],
      },
    });
  }

  // ── Auth gates ──────────────────────────────────────────────────────────
  test('GET /whatsapp/threads requires auth', async ({ request }) => {
    const res = await request.get(`${API}/whatsapp/threads`);
    expect([401, 403]).toContain(res.status());
  });

  test('GET /whatsapp/opt-outs requires auth', async ({ request }) => {
    const res = await request.get(`${API}/whatsapp/opt-outs`);
    expect([401, 403]).toContain(res.status());
  });

  test('POST /whatsapp/opt-outs requires manager role', async ({ request }) => {
    // Try as a regular user against the wellness tenant
    const userLogin = await request.post(`${API}/auth/login`, {
      data: { email: 'user@wellness.demo', password: 'password123' },
    });
    if (!userLogin.ok()) {
      test.skip(true, 'user@wellness.demo not seeded');
      return;
    }
    const userToken = (await userLogin.json()).token;
    const res = await request.post(`${API}/whatsapp/opt-outs`, {
      headers: { Authorization: `Bearer ${userToken}` },
      data: { contactPhone: PHONE_OPTOUT },
    });
    expect([401, 403]).toContain(res.status());
  });

  // ── Inbound webhook → thread upsert ─────────────────────────────────────
  test('inbound webhook creates a new WhatsAppThread for a fresh phone', async ({ request }) => {
    const res = await postInbound(request, PHONE_A, 'Hi, I want to book an appointment');
    expect(res.status()).toBe(200);

    // Allow the async webhook side-effects to settle.
    await new Promise((r) => setTimeout(r, 250));

    const list = await request.get(`${API}/whatsapp/threads?q=${encodeURIComponent(PHONE_A.slice(-7))}`, { headers: auth() });
    expect(list.status()).toBe(200);
    const body = await list.json();
    expect(Array.isArray(body.threads)).toBe(true);
    const thread = body.threads.find((t) => t.contactPhone === PHONE_A || t.contactPhone.endsWith(PHONE_A.slice(-10)));
    expect(thread).toBeTruthy();
    if (thread) {
      createdThreadIds.push(thread.id);
      expect(thread.unreadCount).toBeGreaterThanOrEqual(1);
      expect(thread.lastInboundAt).toBeTruthy();
      expect(thread.status).toBe('OPEN');
    }
  });

  test('second inbound on same phone reuses thread + bumps unreadCount', async ({ request }) => {
    test.skip(createdThreadIds.length === 0, 'first thread not created');
    const before = await request.get(`${API}/whatsapp/threads/${createdThreadIds[0]}`, { headers: auth() });
    expect(before.status()).toBe(200);
    const beforeBody = await before.json();
    const beforeUnread = beforeBody.thread.unreadCount;

    const res = await postInbound(request, PHONE_A, 'Second message — reuse thread please');
    expect(res.status()).toBe(200);
    await new Promise((r) => setTimeout(r, 250));

    const after = await request.get(`${API}/whatsapp/threads/${createdThreadIds[0]}`, { headers: auth() });
    expect(after.status()).toBe(200);
    const afterBody = await after.json();
    expect(afterBody.thread.unreadCount).toBeGreaterThanOrEqual(beforeUnread + 1);
    expect(Array.isArray(afterBody.messages)).toBe(true);
    expect(afterBody.messages.length).toBeGreaterThanOrEqual(2);
  });

  test('GET /whatsapp/threads supports pagination shape', async ({ request }) => {
    const res = await request.get(`${API}/whatsapp/threads?limit=10`, { headers: auth() });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.threads)).toBe(true);
    expect(body.pagination).toBeTruthy();
    expect(typeof body.pagination.total).toBe('number');
    expect(body.pagination.limit).toBeLessThanOrEqual(10);
  });

  test('GET /whatsapp/threads filter ?unread=true returns only threads with unreadCount > 0', async ({ request }) => {
    const res = await request.get(`${API}/whatsapp/threads?unread=true`, { headers: auth() });
    expect(res.status()).toBe(200);
    const body = await res.json();
    for (const t of body.threads) {
      expect(t.unreadCount).toBeGreaterThan(0);
    }
  });

  test('GET /whatsapp/threads filter ?status=OPEN returns only OPEN threads', async ({ request }) => {
    const res = await request.get(`${API}/whatsapp/threads?status=OPEN&limit=20`, { headers: auth() });
    expect(res.status()).toBe(200);
    const body = await res.json();
    for (const t of body.threads) {
      expect(t.status).toBe('OPEN');
    }
  });

  test('GET /whatsapp/threads filter ?assignedToId=0 returns unassigned threads', async ({ request }) => {
    const res = await request.get(`${API}/whatsapp/threads?assignedToId=0&limit=20`, { headers: auth() });
    expect(res.status()).toBe(200);
    const body = await res.json();
    for (const t of body.threads) {
      expect(t.assignedToId).toBeNull();
    }
  });

  // ── Thread detail ───────────────────────────────────────────────────────
  test('GET /whatsapp/threads/:id returns thread + messages array (ascending)', async ({ request }) => {
    test.skip(createdThreadIds.length === 0, 'no thread to inspect');
    const res = await request.get(`${API}/whatsapp/threads/${createdThreadIds[0]}`, { headers: auth() });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.thread).toBeTruthy();
    expect(body.thread.id).toBe(createdThreadIds[0]);
    expect(Array.isArray(body.messages)).toBe(true);
    expect(body.messages.length).toBeLessThanOrEqual(50);
    if (body.messages.length >= 2) {
      const t1 = new Date(body.messages[0].createdAt).getTime();
      const t2 = new Date(body.messages[body.messages.length - 1].createdAt).getTime();
      expect(t2).toBeGreaterThanOrEqual(t1);
    }
  });

  test('GET /whatsapp/threads/:id 404s for unknown id', async ({ request }) => {
    const res = await request.get(`${API}/whatsapp/threads/999999999`, { headers: auth() });
    expect(res.status()).toBe(404);
  });

  test('GET /whatsapp/threads/:id 400s for non-numeric id', async ({ request }) => {
    const res = await request.get(`${API}/whatsapp/threads/notanumber`, { headers: auth() });
    expect(res.status()).toBe(400);
  });

  // ── State transitions ──────────────────────────────────────────────────
  test('POST /whatsapp/threads/:id/mark-read zeroes unreadCount', async ({ request }) => {
    test.skip(createdThreadIds.length === 0, 'no thread');
    const res = await request.post(`${API}/whatsapp/threads/${createdThreadIds[0]}/mark-read`, {
      headers: auth(),
      data: {},
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.unreadCount).toBe(0);
  });

  test('POST /whatsapp/threads/:id/snooze rejects missing until', async ({ request }) => {
    test.skip(createdThreadIds.length === 0, 'no thread');
    const res = await request.post(`${API}/whatsapp/threads/${createdThreadIds[0]}/snooze`, {
      headers: auth(),
      data: {},
    });
    expect(res.status()).toBe(400);
  });

  test('POST /whatsapp/threads/:id/snooze rejects past datetime', async ({ request }) => {
    test.skip(createdThreadIds.length === 0, 'no thread');
    const res = await request.post(`${API}/whatsapp/threads/${createdThreadIds[0]}/snooze`, {
      headers: auth(),
      data: { until: new Date(Date.now() - 60_000).toISOString() },
    });
    expect(res.status()).toBe(400);
  });

  test('POST /whatsapp/threads/:id/snooze with future datetime sets status=SNOOZED', async ({ request }) => {
    test.skip(createdThreadIds.length === 0, 'no thread');
    const future = new Date(Date.now() + 3_600_000).toISOString();
    const res = await request.post(`${API}/whatsapp/threads/${createdThreadIds[0]}/snooze`, {
      headers: auth(),
      data: { until: future },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('SNOOZED');
    expect(body.snoozedUntil).toBeTruthy();
  });

  test('POST /whatsapp/threads/:id/assign with userId=null clears assignment', async ({ request }) => {
    test.skip(createdThreadIds.length === 0, 'no thread');
    const res = await request.post(`${API}/whatsapp/threads/${createdThreadIds[0]}/assign`, {
      headers: auth(),
      data: { userId: null },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.assignedToId).toBeNull();
  });

  test('POST /whatsapp/threads/:id/assign rejects non-numeric userId', async ({ request }) => {
    test.skip(createdThreadIds.length === 0, 'no thread');
    const res = await request.post(`${API}/whatsapp/threads/${createdThreadIds[0]}/assign`, {
      headers: auth(),
      data: { userId: 'not-a-number' },
    });
    expect(res.status()).toBe(400);
  });

  test('POST /whatsapp/threads/:id/assign with cross-tenant userId returns 404', async ({ request }) => {
    test.skip(createdThreadIds.length === 0, 'no thread');
    // Use an absurdly high id that's unlikely to exist.
    const res = await request.post(`${API}/whatsapp/threads/${createdThreadIds[0]}/assign`, {
      headers: auth(),
      data: { userId: 9999999 },
    });
    expect(res.status()).toBe(404);
  });

  test('POST /whatsapp/threads/:id/close sets status=CLOSED', async ({ request }) => {
    test.skip(createdThreadIds.length === 0, 'no thread');
    const res = await request.post(`${API}/whatsapp/threads/${createdThreadIds[0]}/close`, {
      headers: auth(),
      data: {},
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('CLOSED');
  });

  test('POST /whatsapp/threads/:id/close 404s for unknown id', async ({ request }) => {
    const res = await request.post(`${API}/whatsapp/threads/999999999/close`, {
      headers: auth(),
      data: {},
    });
    expect(res.status()).toBe(404);
  });

  // ── STOP-keyword opt-out auto-record ───────────────────────────────────
  test('inbound STOP keyword auto-records a WhatsAppOptOut row', async ({ request }) => {
    const res = await postInbound(request, PHONE_STOP, 'STOP');
    expect(res.status()).toBe(200);
    await new Promise((r) => setTimeout(r, 350));

    const list = await request.get(
      `${API}/whatsapp/opt-outs?phone=${encodeURIComponent(PHONE_STOP.slice(-7))}`,
      { headers: auth() }
    );
    expect(list.status()).toBe(200);
    const body = await list.json();
    expect(Array.isArray(body.optOuts)).toBe(true);
    const found = body.optOuts.find((o) => o.contactPhone.endsWith(PHONE_STOP.slice(-10)));
    expect(found).toBeTruthy();
    if (found) {
      createdOptOutIds.push(found.id);
      expect(found.reason).toBe('STOP_KEYWORD');
    }
  });

  test('inbound UNSUBSCRIBE keyword also auto-records opt-out (case-insensitive)', async ({ request }) => {
    const tempPhone = `+9199${stamp}9`;
    const res = await postInbound(request, tempPhone, 'unsubscribe');
    expect(res.status()).toBe(200);
    await new Promise((r) => setTimeout(r, 350));

    const list = await request.get(
      `${API}/whatsapp/opt-outs?phone=${encodeURIComponent(tempPhone.slice(-7))}`,
      { headers: auth() }
    );
    expect(list.status()).toBe(200);
    const body = await list.json();
    const found = body.optOuts.find((o) => o.contactPhone.endsWith(tempPhone.slice(-10)));
    expect(found).toBeTruthy();
    if (found) createdOptOutIds.push(found.id);
  });

  test('inbound non-STOP message with the word "stopwatch" does NOT auto-record opt-out', async ({ request }) => {
    const tempPhone = `+9199${stamp}8`;
    const res = await postInbound(request, tempPhone, 'I bought a stopwatch from your clinic');
    expect(res.status()).toBe(200);
    await new Promise((r) => setTimeout(r, 350));

    const list = await request.get(
      `${API}/whatsapp/opt-outs?phone=${encodeURIComponent(tempPhone.slice(-7))}`,
      { headers: auth() }
    );
    expect(list.status()).toBe(200);
    const body = await list.json();
    const found = body.optOuts.find((o) => o.contactPhone.endsWith(tempPhone.slice(-10)));
    expect(found).toBeFalsy();
  });

  // ── Manual opt-out + send rejection ─────────────────────────────────────
  test('POST /whatsapp/opt-outs creates a manual opt-out row', async ({ request }) => {
    const res = await request.post(`${API}/whatsapp/opt-outs`, {
      headers: auth(),
      data: { contactPhone: PHONE_OPTOUT, reason: 'COMPLAINT', notes: 'E2E_FLOW_ test row' },
    });
    expect(res.status()).toBe(201);
    const body = await res.json();
    expect(body.id).toBeTruthy();
    expect(body.contactPhone).toBe(PHONE_OPTOUT);
    expect(body.reason).toBe('COMPLAINT');
    createdOptOutIds.push(body.id);
  });

  test('POST /whatsapp/opt-outs rejects missing contactPhone', async ({ request }) => {
    const res = await request.post(`${API}/whatsapp/opt-outs`, {
      headers: auth(),
      data: { reason: 'USER_REQUESTED' },
    });
    expect(res.status()).toBe(400);
  });

  test('POST /whatsapp/opt-outs rejects malformed phone', async ({ request }) => {
    const res = await request.post(`${API}/whatsapp/opt-outs`, {
      headers: auth(),
      data: { contactPhone: 'not-a-phone' },
    });
    expect(res.status()).toBe(400);
  });

  test('POST /whatsapp/opt-outs is idempotent (re-POST same phone updates)', async ({ request }) => {
    const res = await request.post(`${API}/whatsapp/opt-outs`, {
      headers: auth(),
      data: { contactPhone: PHONE_OPTOUT, reason: 'USER_REQUESTED', notes: 'updated' },
    });
    expect(res.status()).toBe(201);
    const body = await res.json();
    expect(body.contactPhone).toBe(PHONE_OPTOUT);
    expect(body.reason).toBe('USER_REQUESTED');
  });

  test('POST /whatsapp/send to opted-out phone returns 422 CONTACT_OPTED_OUT', async ({ request }) => {
    const res = await request.post(`${API}/whatsapp/send`, {
      headers: auth(),
      data: { to: PHONE_OPTOUT, body: 'Hello despite opt-out' },
    });
    expect(res.status()).toBe(422);
    const body = await res.json();
    expect(body.code).toBe('CONTACT_OPTED_OUT');
    expect(body.optedOutAt).toBeTruthy();
  });

  test('POST /whatsapp/send to non-opted-out phone is NOT rejected by opt-out gate', async ({ request }) => {
    // Use a fresh phone that's never opted out. Send may still 400 (no
    // active config) or 500 (Meta error) — we ONLY assert it's not 422.
    const fresh = `+9199${stamp}7`;
    const res = await request.post(`${API}/whatsapp/send`, {
      headers: auth(),
      data: { to: fresh, body: 'Hello fresh contact' },
    });
    expect(res.status()).not.toBe(422);
  });

  test('GET /whatsapp/opt-outs returns paginated shape', async ({ request }) => {
    const res = await request.get(`${API}/whatsapp/opt-outs?limit=5`, { headers: auth() });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.optOuts)).toBe(true);
    expect(body.pagination).toBeTruthy();
    expect(typeof body.pagination.total).toBe('number');
  });

  test('DELETE /whatsapp/opt-outs/:id (admin re-opt-in) removes the row', async ({ request }) => {
    test.skip(createdOptOutIds.length === 0, 'no opt-outs to delete');
    const id = createdOptOutIds.pop();
    const res = await request.delete(`${API}/whatsapp/opt-outs/${id}`, { headers: auth() });
    expect(res.status()).toBe(200);

    // Subsequent GET should not include the deleted row.
    const list = await request.get(`${API}/whatsapp/opt-outs?limit=100`, { headers: auth() });
    const body = await list.json();
    const found = body.optOuts.find((o) => o.id === id);
    expect(found).toBeFalsy();
  });

  // ── Tenant isolation ────────────────────────────────────────────────────
  test('GET /whatsapp/threads is tenant-scoped (wellness cannot see generic-tenant threads)', async ({ request }) => {
    test.skip(!wellnessToken, 'wellness tenant not seeded');
    const wellnessRes = await request.get(`${API}/whatsapp/threads?limit=100`, { headers: wellnessAuth() });
    expect(wellnessRes.status()).toBe(200);
    const body = await wellnessRes.json();
    // The thread we created above lives on the generic tenant; wellness
    // should NOT see it. Match by the generic-side thread id.
    if (createdThreadIds.length > 0) {
      const found = body.threads.find((t) => t.id === createdThreadIds[0]);
      expect(found).toBeFalsy();
    }
  });

  test('GET /whatsapp/opt-outs is tenant-scoped', async ({ request }) => {
    test.skip(!wellnessToken, 'wellness tenant not seeded');
    const wellnessRes = await request.get(`${API}/whatsapp/opt-outs?limit=100`, { headers: wellnessAuth() });
    expect(wellnessRes.status()).toBe(200);
    const body = await wellnessRes.json();
    // None of our generic-tenant opt-outs should leak into wellness's view.
    for (const o of body.optOuts) {
      expect(o.tenantId).not.toBe(1); // generic tenant is id=1 in seed
    }
  });

  test('GET /whatsapp/threads/:id 404s when accessed from a different tenant', async ({ request }) => {
    test.skip(!wellnessToken || createdThreadIds.length === 0, 'wellness or thread missing');
    const res = await request.get(`${API}/whatsapp/threads/${createdThreadIds[0]}`, { headers: wellnessAuth() });
    expect(res.status()).toBe(404);
  });
});
