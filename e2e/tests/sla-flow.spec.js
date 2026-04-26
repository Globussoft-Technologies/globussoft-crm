// @ts-check
/**
 * SLA + Tickets — DEEP BUSINESS-LOGIC FLOW SPEC
 *
 * This is NOT a smoke spec — it asserts that the SLA engine actually works:
 *   Flow 1: ticket creation auto-populates slaResponseDue / slaResolveDue when
 *           a matching active SlaPolicy exists for the ticket's priority
 *   Flow 2: a status change off "Open" stamps firstResponseAt and the ticket
 *           does NOT appear in GET /api/sla/breaches as a response breach
 *   Flow 3: a ticket whose slaResponseDue has already passed surfaces in
 *           GET /api/sla/breaches with responseBreach=true and a positive
 *           responseOverdueMinutes
 *   Flow 4: cross-tenant isolation — generic-tenant ticket + policy never
 *           bleed into wellness-tenant listings
 *
 * Architecture notes discovered while reading backend/routes/*.js:
 *   - There are TWO ticket routers:
 *       /api/tickets   (backend/routes/tickets.js)  -- shape-only CRUD,
 *                       NO SLA auto-apply, NO firstResponseAt stamping
 *       /api/support   (backend/routes/support.js)  -- the ticketing engine,
 *                       auto-applies the matching active SlaPolicy on POST,
 *                       stamps firstResponseAt on first non-Open status,
 *                       stamps resolvedAt when status -> Resolved
 *   This spec drives /api/support for Flows 1-3 because that is where the
 *   business logic lives. /api/tickets is exercised in Flow 4 to confirm both
 *   routers respect tenant scoping.
 *
 *   - Breach detection is on-read in GET /api/sla/breaches. There is NO cron
 *     that flips a `breached` flag (no such column on Ticket). The route
 *     compares slaResponseDue/slaResolveDue against `now` at query time and
 *     returns synthesized booleans `responseBreach`, `resolveBreach`, plus
 *     `responseOverdueMinutes` / `resolveOverdueMinutes`.
 *
 *   - To force an immediate breach without sleeping: create the SlaPolicy with
 *     responseMinutes=1 (POST coerces 0 -> default 60 because `parseInt(0)||60`
 *     is 60), then PUT responseMinutes=0 (PUT uses bare `parseInt`, so 0
 *     persists), then POST /api/sla/apply/:ticketId. With responseMinutes=0
 *     the computed slaResponseDue equals ticket.createdAt, which is < now()
 *     immediately. createdAt cannot be back-dated via API because
 *     middleware/validateInput.js stripDangerous() deletes req.body.createdAt.
 */
const { test, expect } = require('@playwright/test');

const BASE_URL = process.env.BASE_URL || 'https://crm.globusdemos.com';
const API = `${BASE_URL}/api`;

const GENERIC_ADMIN_EMAIL = 'admin@globussoft.com';
const GENERIC_ADMIN_PASSWORD = 'password123';
const WELLNESS_ADMIN_EMAIL = 'admin@wellness.demo';
const WELLNESS_ADMIN_PASSWORD = 'password123';

const STAMP = Date.now();
const TAG = `E2E_FLOW_${STAMP}`;
// Unique priority isolates this run from any seeded High-priority policy that
// would otherwise also match our High-priority ticket.
const FIXTURE_PRIORITY = `High`; // we override with isolated priority below
const ISO_PRIORITY = `E2EPRIO_${STAMP}`;

let genericToken = '';
let wellnessToken = '';
let createdTicketId = null;
let createdPolicyId = null;
let crossTenantTicketId = null;

test.describe.configure({ mode: 'serial' });

test.describe('SLA + Tickets — deep business-logic flow', () => {
  test.beforeAll(async ({ request }) => {
    const g = await request.post(`${API}/auth/login`, {
      data: { email: GENERIC_ADMIN_EMAIL, password: GENERIC_ADMIN_PASSWORD },
    });
    expect(g.ok(), 'generic admin login must succeed').toBeTruthy();
    genericToken = (await g.json()).token;
    expect(genericToken).toBeTruthy();

    const w = await request.post(`${API}/auth/login`, {
      data: { email: WELLNESS_ADMIN_EMAIL, password: WELLNESS_ADMIN_PASSWORD },
    });
    expect(w.ok(), 'wellness admin login must succeed').toBeTruthy();
    wellnessToken = (await w.json()).token;
    expect(wellnessToken).toBeTruthy();
    expect(genericToken).not.toBe(wellnessToken);
  });

  test.afterAll(async ({ request }) => {
    if (createdTicketId) {
      await request.delete(`${API}/support/${createdTicketId}`, {
        headers: { Authorization: `Bearer ${genericToken}` },
      });
    }
    if (crossTenantTicketId) {
      await request.delete(`${API}/support/${crossTenantTicketId}`, {
        headers: { Authorization: `Bearer ${genericToken}` },
      });
    }
    if (createdPolicyId) {
      await request.delete(`${API}/sla/policies/${createdPolicyId}`, {
        headers: { Authorization: `Bearer ${genericToken}` },
      });
    }
  });

  const gauth = () => ({ Authorization: `Bearer ${genericToken}` });
  const wauth = () => ({ Authorization: `Bearer ${wellnessToken}` });

  // ─── Flow 1: ticket creation populates SLA fields ─────────────────────
  test('Flow 1 — POST /api/support auto-applies SlaPolicy matching priority', async ({ request }) => {
    // Create a policy for an isolated priority so seeded High-priority policies
    // (if any) cannot satisfy our assertions by accident.
    const RESPONSE_MIN = 60;
    const RESOLVE_MIN = 1440;
    const policyRes = await request.post(`${API}/sla/policies`, {
      headers: gauth(),
      data: {
        name: `${TAG}_policy`,
        priority: ISO_PRIORITY,
        responseMinutes: RESPONSE_MIN,
        resolveMinutes: RESOLVE_MIN,
        isActive: true,
      },
    });
    expect(policyRes.status(), `create policy: ${await policyRes.text()}`).toBe(201);
    const policy = await policyRes.json();
    createdPolicyId = policy.id;
    expect(policy.responseMinutes).toBe(RESPONSE_MIN);
    expect(policy.resolveMinutes).toBe(RESOLVE_MIN);
    expect(policy.isActive).toBe(true);

    // Submitting a ticket via /api/support triggers auto-apply. The route uses
    // ticket.priority verbatim, so we set it to our isolated priority string.
    const before = Date.now();
    const ticketRes = await request.post(`${API}/support`, {
      headers: gauth(),
      data: {
        subject: `${TAG} — Priya Sharma cannot log in`,
        description: 'Customer Priya Sharma reports a 500 on /auth/login',
        priority: ISO_PRIORITY,
        status: 'Open',
      },
    });
    expect(ticketRes.status(), `create ticket: ${await ticketRes.text()}`).toBe(201);
    const ticket = await ticketRes.json();
    createdTicketId = ticket.id;
    expect(ticket.priority).toBe(ISO_PRIORITY);
    expect(ticket.status).toBe('Open');

    // The auto-apply path runs after create, so re-fetch the ticket to read the
    // computed due timestamps.
    const fetched = await request.get(`${API}/support/${ticket.id}`, { headers: gauth() });
    expect(fetched.status()).toBe(200);
    const t = await fetched.json();
    expect(t.slaResponseDue, 'slaResponseDue should be auto-populated by /api/support POST').toBeTruthy();
    expect(t.slaResolveDue, 'slaResolveDue should be auto-populated by /api/support POST').toBeTruthy();

    // slaResponseDue ≈ createdAt + responseMinutes. Allow ±90s drift for clock
    // skew + handler latency.
    const createdAt = new Date(t.createdAt).getTime();
    const responseDue = new Date(t.slaResponseDue).getTime();
    const resolveDue = new Date(t.slaResolveDue).getTime();
    expect(responseDue - createdAt).toBeGreaterThan(RESPONSE_MIN * 60_000 - 90_000);
    expect(responseDue - createdAt).toBeLessThan(RESPONSE_MIN * 60_000 + 90_000);
    expect(resolveDue - createdAt).toBeGreaterThan(RESOLVE_MIN * 60_000 - 90_000);
    expect(resolveDue - createdAt).toBeLessThan(RESOLVE_MIN * 60_000 + 90_000);

    // firstResponseAt + resolvedAt are unset on a brand-new Open ticket.
    expect(t.firstResponseAt).toBeFalsy();
    expect(t.resolvedAt).toBeFalsy();

    // The ticket is not yet a breach.
    const breaches = await request.get(`${API}/sla/breaches`, { headers: gauth() });
    expect(breaches.status()).toBe(200);
    const breachList = await breaches.json();
    const me = breachList.find((b) => b.id === ticket.id);
    expect(me, 'fresh ticket must not appear in /sla/breaches').toBeFalsy();
  });

  // ─── Flow 2: first response satisfies SLA ─────────────────────────────
  test('Flow 2 — PUT /api/support status→Pending stamps firstResponseAt', async ({ request }) => {
    expect(createdTicketId, 'Flow 1 must have created a ticket').toBeTruthy();

    const before = Date.now();
    const updateRes = await request.put(`${API}/support/${createdTicketId}`, {
      headers: gauth(),
      data: { status: 'Pending' },
    });
    expect(updateRes.status(), `update ticket: ${await updateRes.text()}`).toBe(200);

    const fetched = await request.get(`${API}/support/${createdTicketId}`, { headers: gauth() });
    expect(fetched.status()).toBe(200);
    const t = await fetched.json();
    expect(t.status).toBe('Pending');
    expect(t.firstResponseAt, 'firstResponseAt must be stamped by support.js when status moves off Open').toBeTruthy();

    const stamped = new Date(t.firstResponseAt).getTime();
    const after = Date.now();
    // firstResponseAt was set by the server within this request window
    // (allow a small backwards skew for server clock).
    expect(stamped).toBeGreaterThan(before - 60_000);
    expect(stamped).toBeLessThanOrEqual(after + 5_000);

    // Resolved-only field must still be unset.
    expect(t.resolvedAt).toBeFalsy();

    // Because firstResponseAt is set, /sla/breaches no longer flags this
    // ticket on the response leg even after the response window passes.
    const breaches = await request.get(`${API}/sla/breaches`, { headers: gauth() });
    const breachList = await breaches.json();
    const me = breachList.find((b) => b.id === createdTicketId);
    if (me) {
      // It might still appear for a *resolve* breach in a future flow, but
      // never for a response breach once firstResponseAt is set.
      expect(me.responseBreach).toBe(false);
    }
  });

  // ─── Flow 3: breach detection ─────────────────────────────────────────
  test('Flow 3 — ticket with responseMinutes=0 surfaces as a breach on read', async ({ request }) => {
    expect(createdPolicyId, 'Flow 1 must have created a policy').toBeTruthy();

    // Create a fresh ticket WITHOUT any first response. We need this because
    // Flow 2 already stamped firstResponseAt on the first ticket.
    const ticketRes = await request.post(`${API}/support`, {
      headers: gauth(),
      data: {
        subject: `${TAG} — Arjun Patel reports stuck queue`,
        description: 'Customer Arjun Patel: outbound queue frozen since 09:00',
        priority: ISO_PRIORITY,
        status: 'Open',
      },
    });
    expect(ticketRes.status()).toBe(201);
    const breachTicket = await ticketRes.json();
    crossTenantTicketId = breachTicket.id; // reuse afterAll cleanup slot

    // Force the policy to a 0-minute response window. POST coerces 0 -> 60
    // because `parseInt(0) || 60` is 60, but PUT uses bare parseInt and lets
    // 0 through. Verified by reading backend/routes/sla.js line 69.
    const putRes = await request.put(`${API}/sla/policies/${createdPolicyId}`, {
      headers: gauth(),
      data: { responseMinutes: 0 },
    });
    expect(putRes.status()).toBe(200);
    expect((await putRes.json()).responseMinutes).toBe(0);

    // Re-apply the (now 0-minute) policy to our breach ticket. This sets
    // slaResponseDue = createdAt + 0 = createdAt, which is in the past, so the
    // breach detector at /sla/breaches flags it on its very next read.
    const apply = await request.post(`${API}/sla/apply/${breachTicket.id}`, { headers: gauth() });
    expect(apply.status(), `apply: ${await apply.text()}`).toBe(200);
    const applied = (await apply.json()).ticket;
    expect(new Date(applied.slaResponseDue).getTime()).toBeLessThanOrEqual(Date.now());

    // Now the breach feed must include this ticket with responseBreach=true.
    const breaches = await request.get(`${API}/sla/breaches`, { headers: gauth() });
    expect(breaches.status()).toBe(200);
    const list = await breaches.json();
    const me = list.find((b) => b.id === breachTicket.id);
    expect(me, 'breach feed must include the 0-minute ticket').toBeTruthy();
    expect(me.responseBreach).toBe(true);
    expect(me.responseOverdueMinutes).toBeGreaterThanOrEqual(0);
    // firstResponseAt was never set, so the response breach is real.
    expect(me.firstResponseAt).toBeFalsy();

    // Stats endpoint must count this as a breach today.
    const stats = await request.get(`${API}/sla/stats`, { headers: gauth() });
    expect(stats.status()).toBe(200);
    const s = await stats.json();
    expect(s.breachesToday).toBeGreaterThanOrEqual(1);
    expect(s.activePolicies).toBeGreaterThanOrEqual(1);
  });

  // ─── Flow 4: cross-tenant isolation ───────────────────────────────────
  test('Flow 4 — generic tenant ticket + policy invisible to wellness tenant', async ({ request }) => {
    expect(createdTicketId).toBeTruthy();
    expect(createdPolicyId).toBeTruthy();

    // /api/support — wellness admin must NOT see the generic-tenant ticket.
    const wSupport = await request.get(`${API}/support`, { headers: wauth() });
    expect(wSupport.status()).toBe(200);
    const wSupportList = await wSupport.json();
    expect(Array.isArray(wSupportList)).toBe(true);
    expect(wSupportList.find((t) => t.id === createdTicketId)).toBeFalsy();
    expect(wSupportList.find((t) => t.id === crossTenantTicketId)).toBeFalsy();

    // /api/tickets — same expectation against the legacy router.
    const wTickets = await request.get(`${API}/tickets`, { headers: wauth() });
    expect(wTickets.status()).toBe(200);
    const wTicketList = await wTickets.json();
    expect(wTicketList.find((t) => t.id === createdTicketId)).toBeFalsy();

    // Direct GET /api/support/:id from the wrong tenant must 404 (not 200).
    const direct = await request.get(`${API}/support/${createdTicketId}`, { headers: wauth() });
    expect(direct.status(), 'cross-tenant direct fetch must 404').toBe(404);

    // /api/sla/policies — wellness admin must NOT see the generic policy.
    const wPolicies = await request.get(`${API}/sla/policies`, { headers: wauth() });
    expect(wPolicies.status()).toBe(200);
    const wPolicyList = await wPolicies.json();
    expect(Array.isArray(wPolicyList)).toBe(true);
    expect(wPolicyList.find((p) => p.id === createdPolicyId)).toBeFalsy();

    // /api/sla/breaches — wellness admin must NOT see the breached
    // generic-tenant ticket.
    const wBreaches = await request.get(`${API}/sla/breaches`, { headers: wauth() });
    expect(wBreaches.status()).toBe(200);
    const wBreachList = await wBreaches.json();
    expect(wBreachList.find((b) => b.id === crossTenantTicketId)).toBeFalsy();

    // PUT against the generic policy from wellness must 404 (tenant guard).
    const wPut = await request.put(`${API}/sla/policies/${createdPolicyId}`, {
      headers: wauth(),
      data: { responseMinutes: 999 },
    });
    expect(wPut.status()).toBe(404);

    // DELETE against the generic policy from wellness must 404 too.
    const wDel = await request.delete(`${API}/sla/policies/${createdPolicyId}`, { headers: wauth() });
    expect(wDel.status()).toBe(404);
  });
});
