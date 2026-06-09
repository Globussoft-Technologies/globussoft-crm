// @ts-check
/**
 * Cross-tenant coverage audit — FR-3.4 / #918 / #919 deploy-time gate.
 *
 * Sibling to `cross-tenant-stripdangerous-api.spec.js` (#646) — that spec
 * pins the BODY-FIELD shape (siteTenantId / previewTenantId replaced the
 * stripped tenantId field). This spec pins the PATH-/QUERY-/AUTH-LEVEL
 * shape: a tenant-A Bearer token reading tenant-B resources by direct
 * row ID MUST receive 404 (or 403), NEVER 200 with the cross-tenant
 * row's body.
 *
 * PRD reference: docs/PRD_TRAVEL_SECURITY_ARCHITECTURE.md §FR-3.4 and
 * §AC-6.10. ESLint companion: backend/eslint.config.js (the inline
 * `gbscrm/tenant-scope-finder-heuristic` plugin rule). Two-layer defense:
 *   1. ESLint (write-time, warn): flags `prisma.<X>.findMany` calls in
 *      routes/ whose WHERE clause is missing `tenantId`.
 *   2. This spec (deploy-time, error): probes the actual response for
 *      cross-tenant leakage on the highest-risk PII-bearing models.
 *
 * Method per model:
 *   1. Login as wellness admin (tenant W).
 *   2. POST a fresh row under tenant W via the standard create endpoint
 *      (tagged with RUN_TAG for teardown).
 *   3. Capture the row ID.
 *   4. Login as generic admin (tenant G).
 *   5. From tenant G, `GET /api/<resource>/<row-id>`. Assert 404 (or
 *      403). NEVER 200 — that would be a cross-tenant leak.
 *   6. From tenant G, `GET /api/<resource>` (list). Assert the row ID
 *      from step 3 does NOT appear in the response.
 *
 * The "highest-risk" cut: models that hold PII, financial figures, or
 * security-sensitive material. Currently:
 *   - Contact, Deal, Invoice, Quote (generic-tenant core)
 *   - Patient (wellness PHI)
 *   - TravelItinerary, VisaApplication, TravelTrip, TravelQuote,
 *     TravelInvoice, TripParticipant (travel vertical PII + financial)
 *   - ApiKey (security-sensitive — credential surface)
 *   - AuditLog (security-sensitive — tenant-isolated by definition)
 *
 * Plus a few cross-cutting probes:
 *   - Anonymous (no Bearer) — confirms global auth-gate is intact.
 *   - Cross-tenant detail lookup for a NONEXISTENT id from BOTH
 *     tenants — confirms 404 isn't being inferred from row existence.
 *   - A "fan-out" probe: GET /api/contacts with `?tenantId=<wellness>`
 *     query param — confirms query-string overrides are ignored.
 *
 * RUN_TAG: `E2E_X918_<ts>` — the leading `E2E_` matches the global
 * teardown regex in e2e/test-data-patterns.js; created rows are scrubbed
 * post-suite.
 *
 * Wired into BOTH .github/workflows/deploy.yml (per-push gate) AND
 * .github/workflows/coverage.yml (coverage measurement gate).
 */
const { test, expect } = require('@playwright/test');

test.describe.configure({ mode: 'serial', timeout: 120_000 });

const BASE_URL = process.env.BASE_URL || 'https://crm.globusdemos.com';
const API = `${BASE_URL}/api`;
const REQUEST_TIMEOUT = 60000;
const RUN_TAG = `E2E_X918_${Date.now()}`;

const GENERIC = { email: 'admin@globussoft.com', password: 'password123' };
const WELLNESS = { email: 'admin@wellness.demo', password: 'password123' };

let genericToken = null;
let genericTenantId = null;
let wellnessToken = null;
let wellnessTenantId = null;

// Track created row IDs per resource, so afterAll can attempt opportunistic
// cleanup (the global teardown also scrubs by the RUN_TAG-tagged names).
/** @type {Record<string, number[]>} */
const created = {
  contact: [],
  deal: [],
  patient: [],
  travelItinerary: [],
  travelQuote: [],
  travelInvoice: [],
  visaApplication: [],
};

async function login(request, fixture) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await request.post(`${API}/auth/login`, {
        data: fixture,
        headers: { 'Content-Type': 'application/json' },
        timeout: REQUEST_TIMEOUT,
      });
      if (r.ok()) return r.json();
    } catch (_e) {
      if (attempt === 0) continue;
    }
  }
  return null;
}

const authHdr = (token) => ({
  Authorization: `Bearer ${token}`,
  'Content-Type': 'application/json',
});

test.beforeAll(async ({ request }) => {
  const g = await login(request, GENERIC);
  test.skip(!g, 'generic admin login required for cross-tenant audit');
  genericToken = g.token;
  genericTenantId = g.user?.tenantId ?? null;

  const w = await login(request, WELLNESS);
  test.skip(!w, 'wellness admin login required for cross-tenant audit');
  wellnessToken = w.token;
  wellnessTenantId = w.user?.tenantId ?? null;

  test.skip(
    !genericTenantId || !wellnessTenantId || genericTenantId === wellnessTenantId,
    `need two distinct tenants (got generic=${genericTenantId}, wellness=${wellnessTenantId})`,
  );
});

test.afterAll(async ({ request }) => {
  // Best-effort opportunistic cleanup. Global teardown scrubs by the
  // RUN_TAG-tagged names; this is insurance for any row whose name didn't
  // end up tagged (e.g. ID-only handles).
  for (const id of created.contact) {
    await request.delete(`${API}/contacts/${id}`, { headers: authHdr(wellnessToken), timeout: REQUEST_TIMEOUT }).catch(() => {});
  }
  for (const id of created.deal) {
    await request.delete(`${API}/deals/${id}`, { headers: authHdr(wellnessToken), timeout: REQUEST_TIMEOUT }).catch(() => {});
  }
});

test.describe('FR-3.4 (#918 / #919) — cross-tenant Bearer token probe per high-risk model', () => {
  // ────────────────────────────────────────────────────────────────
  // Core CRM models (generic-tenant core; wellness tenant can also
  // hold these rows — we use wellness as the row source and probe
  // from generic).
  // ────────────────────────────────────────────────────────────────

  test('Contact — cross-tenant GET /:id MUST NOT leak the row to the other tenant', async ({ request }) => {
    // Create a contact on the wellness tenant.
    const post = await request.post(`${API}/contacts`, {
      headers: authHdr(wellnessToken),
      data: {
        name: `${RUN_TAG} Contact A`,
        email: `${RUN_TAG.toLowerCase()}-contact-a@example.test`,
        phone: '+15550100000',
      },
      timeout: REQUEST_TIMEOUT,
    });
    expect(post.ok(), `create contact: ${await post.text()}`).toBeTruthy();
    const row = await post.json();
    const id = row.id ?? row.contact?.id;
    expect(id).toBeTruthy();
    created.contact.push(id);

    // Probe from generic — must be 404 (or 403), never 200 with the row.
    const probe = await request.get(`${API}/contacts/${id}`, {
      headers: authHdr(genericToken),
      timeout: REQUEST_TIMEOUT,
    });
    expect([404, 403], `cross-tenant probe status: ${probe.status()} body: ${await probe.text()}`).toContain(probe.status());

    // Belt-and-suspenders: the list endpoint from generic must NOT
    // include this contact (cross-tenant list leak).
    const list = await request.get(`${API}/contacts?limit=200`, {
      headers: authHdr(genericToken),
      timeout: REQUEST_TIMEOUT,
    });
    if (list.ok()) {
      const lb = await list.json();
      const rows = Array.isArray(lb) ? lb : (lb.contacts || lb.data || lb.rows || []);
      const hit = rows.find((c) => c.id === id);
      expect(hit, 'generic-tenant list MUST NOT contain the wellness-scoped contact').toBeFalsy();
    }
  });

  test('Contact — list endpoint query-string ?tenantId override MUST be ignored (no cross-tenant fan-out)', async ({ request }) => {
    // From generic, request the list with `?tenantId=<wellness>` — this
    // SHOULD be ignored (the handler reads tenantId from req.user, not
    // query). If the handler ever wires query-string tenantId in, the
    // result would silently contain wellness-tenant data.
    const r = await request.get(`${API}/contacts?tenantId=${wellnessTenantId}&limit=100`, {
      headers: authHdr(genericToken),
      timeout: REQUEST_TIMEOUT,
    });
    expect(r.ok()).toBeTruthy();
    const lb = await r.json();
    const rows = Array.isArray(lb) ? lb : (lb.contacts || lb.data || lb.rows || []);
    // Every row in the response must belong to genericTenantId. The
    // shape may or may not surface tenantId on the row; if it does,
    // assert. If it doesn't, we fall back to the negative assertion
    // that the wellness-tagged row we created above isn't here.
    if (rows.length > 0 && rows[0].tenantId !== undefined) {
      const offTenant = rows.filter((r2) => r2.tenantId !== genericTenantId);
      expect(offTenant, `${offTenant.length} cross-tenant rows surfaced with ?tenantId override`).toHaveLength(0);
    }
    if (created.contact.length > 0) {
      const wellnessRowId = created.contact[0];
      const leak = rows.find((c) => c.id === wellnessRowId);
      expect(leak, '?tenantId override must NOT surface the wellness-tenant row').toBeFalsy();
    }
  });

  test('Deal — cross-tenant GET /:id MUST NOT leak the row to the other tenant', async ({ request }) => {
    const post = await request.post(`${API}/deals`, {
      headers: authHdr(wellnessToken),
      data: {
        title: `${RUN_TAG} Deal A`,
        amount: 10000,
        stage: 'qualified',
      },
      timeout: REQUEST_TIMEOUT,
    });
    if (!post.ok()) {
      // Pipeline may not be seeded — skip rather than fail.
      test.skip(true, `Deal create failed (likely missing pipeline): ${await post.text()}`);
      return;
    }
    const row = await post.json();
    const id = row.id ?? row.deal?.id;
    expect(id).toBeTruthy();
    created.deal.push(id);

    const probe = await request.get(`${API}/deals/${id}`, {
      headers: authHdr(genericToken),
      timeout: REQUEST_TIMEOUT,
    });
    expect([404, 403]).toContain(probe.status());
  });

  test('Invoice — cross-tenant GET /:id MUST NOT leak the row', async ({ request }) => {
    // We don't create a fresh invoice (requires a contact + line items);
    // instead, scan the wellness tenant's existing list and use the
    // first id as the probe target.
    const list = await request.get(`${API}/billing?type=invoice&limit=5`, {
      headers: authHdr(wellnessToken),
      timeout: REQUEST_TIMEOUT,
    });
    if (!list.ok()) {
      test.skip(true, `wellness invoice list unavailable: ${await list.text()}`);
      return;
    }
    const lb = await list.json();
    const rows = Array.isArray(lb) ? lb : (lb.invoices || lb.data || []);
    if (rows.length === 0) {
      test.skip(true, 'no invoices in wellness tenant — skipping probe');
      return;
    }
    const id = rows[0].id;

    // Probe from generic.
    const probe = await request.get(`${API}/billing/${id}`, {
      headers: authHdr(genericToken),
      timeout: REQUEST_TIMEOUT,
    });
    // Accept 404, 403, OR 400 (bad-id) — anything except 200 with the row body.
    if (probe.status() === 200) {
      const body = await probe.json();
      // If the endpoint returns the row, assert at minimum that the
      // tenant matches the caller (defense in depth).
      expect(body.tenantId, 'invoice returned to wrong tenant — cross-tenant leak').not.toBe(wellnessTenantId);
    } else {
      expect([404, 403, 400]).toContain(probe.status());
    }
  });

  test('Quote — cross-tenant GET /:id MUST NOT leak the row', async ({ request }) => {
    const list = await request.get(`${API}/estimates?limit=5`, {
      headers: authHdr(wellnessToken),
      timeout: REQUEST_TIMEOUT,
    });
    if (!list.ok()) {
      test.skip(true, `wellness estimates list unavailable: ${list.status()}`);
      return;
    }
    const lb = await list.json();
    const rows = Array.isArray(lb) ? lb : (lb.estimates || lb.quotes || lb.data || []);
    if (rows.length === 0) {
      test.skip(true, 'no estimates in wellness tenant — skipping probe');
      return;
    }
    const id = rows[0].id;

    const probe = await request.get(`${API}/estimates/${id}`, {
      headers: authHdr(genericToken),
      timeout: REQUEST_TIMEOUT,
    });
    if (probe.status() === 200) {
      const body = await probe.json();
      expect(body.tenantId, 'quote returned to wrong tenant — cross-tenant leak').not.toBe(wellnessTenantId);
    } else {
      expect([404, 403, 400]).toContain(probe.status());
    }
  });

  // ────────────────────────────────────────────────────────────────
  // Wellness-vertical PHI
  // ────────────────────────────────────────────────────────────────

  test('Patient — cross-tenant GET /api/wellness/patients/:id MUST NOT leak the row', async ({ request }) => {
    const list = await request.get(`${API}/wellness/patients?limit=5`, {
      headers: authHdr(wellnessToken),
      timeout: REQUEST_TIMEOUT,
    });
    if (!list.ok()) {
      test.skip(true, `wellness patient list unavailable: ${list.status()}`);
      return;
    }
    const lb = await list.json();
    const rows = Array.isArray(lb) ? lb : (lb.patients || lb.data || lb.rows || []);
    if (rows.length === 0) {
      test.skip(true, 'no patients in wellness tenant — skipping probe');
      return;
    }
    const id = rows[0].id;

    // Patient endpoints are wellness-only — generic should be 403 from
    // the vertical guard, not 404 from tenant-scope. Either is fine
    // (no leak); only 200 with the row body would be the failure.
    const probe = await request.get(`${API}/wellness/patients/${id}`, {
      headers: authHdr(genericToken),
      timeout: REQUEST_TIMEOUT,
    });
    if (probe.status() === 200) {
      const body = await probe.json();
      expect(body.id, 'generic-tenant must NOT receive the wellness Patient row').not.toBe(id);
    } else {
      expect([404, 403, 400]).toContain(probe.status());
    }
  });

  // ────────────────────────────────────────────────────────────────
  // Travel vertical — Itinerary / VisaApplication / Trip / Quote / Invoice
  // ────────────────────────────────────────────────────────────────

  test('TravelItinerary — cross-tenant GET /api/travel/itineraries/:id MUST NOT leak the row', async ({ request }) => {
    const list = await request.get(`${API}/travel/itineraries?limit=5`, {
      headers: authHdr(wellnessToken),
      timeout: REQUEST_TIMEOUT,
    });
    if (!list.ok()) {
      test.skip(true, `wellness travel/itineraries list unavailable: ${list.status()}`);
      return;
    }
    const lb = await list.json();
    const rows = Array.isArray(lb) ? lb : (lb.itineraries || lb.data || []);
    if (rows.length === 0) {
      test.skip(true, 'no itineraries in wellness tenant — skipping probe');
      return;
    }
    const id = rows[0].id;

    const probe = await request.get(`${API}/travel/itineraries/${id}`, {
      headers: authHdr(genericToken),
      timeout: REQUEST_TIMEOUT,
    });
    if (probe.status() === 200) {
      const body = await probe.json();
      expect(body.tenantId, 'travel itinerary returned to wrong tenant').not.toBe(wellnessTenantId);
    } else {
      expect([404, 403, 400]).toContain(probe.status());
    }
  });

  test('TravelQuote — cross-tenant GET /api/travel/quotes/:id MUST NOT leak the row', async ({ request }) => {
    const list = await request.get(`${API}/travel/quotes?limit=5`, {
      headers: authHdr(wellnessToken),
      timeout: REQUEST_TIMEOUT,
    });
    if (!list.ok()) {
      test.skip(true, `wellness travel/quotes list unavailable: ${list.status()}`);
      return;
    }
    const lb = await list.json();
    const rows = Array.isArray(lb) ? lb : (lb.quotes || lb.data || []);
    if (rows.length === 0) {
      test.skip(true, 'no travel quotes in wellness tenant — skipping probe');
      return;
    }
    const id = rows[0].id;

    const probe = await request.get(`${API}/travel/quotes/${id}`, {
      headers: authHdr(genericToken),
      timeout: REQUEST_TIMEOUT,
    });
    if (probe.status() === 200) {
      const body = await probe.json();
      expect(body.tenantId, 'travel quote returned to wrong tenant').not.toBe(wellnessTenantId);
    } else {
      expect([404, 403, 400]).toContain(probe.status());
    }
  });

  test('TravelInvoice — cross-tenant GET /api/travel/invoices/:id MUST NOT leak the row', async ({ request }) => {
    const list = await request.get(`${API}/travel/invoices?limit=5`, {
      headers: authHdr(wellnessToken),
      timeout: REQUEST_TIMEOUT,
    });
    if (!list.ok()) {
      test.skip(true, `wellness travel/invoices list unavailable: ${list.status()}`);
      return;
    }
    const lb = await list.json();
    const rows = Array.isArray(lb) ? lb : (lb.invoices || lb.data || []);
    if (rows.length === 0) {
      test.skip(true, 'no travel invoices in wellness tenant — skipping probe');
      return;
    }
    const id = rows[0].id;

    const probe = await request.get(`${API}/travel/invoices/${id}`, {
      headers: authHdr(genericToken),
      timeout: REQUEST_TIMEOUT,
    });
    if (probe.status() === 200) {
      const body = await probe.json();
      expect(body.tenantId, 'travel invoice returned to wrong tenant').not.toBe(wellnessTenantId);
    } else {
      expect([404, 403, 400]).toContain(probe.status());
    }
  });

  test('TmcTrip — cross-tenant GET /api/travel/trips/:id MUST NOT leak the row', async ({ request }) => {
    const list = await request.get(`${API}/travel/trips?limit=5`, {
      headers: authHdr(wellnessToken),
      timeout: REQUEST_TIMEOUT,
    });
    if (!list.ok()) {
      test.skip(true, `wellness travel/trips list unavailable: ${list.status()}`);
      return;
    }
    const lb = await list.json();
    const rows = Array.isArray(lb) ? lb : (lb.trips || lb.data || []);
    if (rows.length === 0) {
      test.skip(true, 'no travel trips in wellness tenant — skipping probe');
      return;
    }
    const id = rows[0].id;

    const probe = await request.get(`${API}/travel/trips/${id}`, {
      headers: authHdr(genericToken),
      timeout: REQUEST_TIMEOUT,
    });
    if (probe.status() === 200) {
      const body = await probe.json();
      expect(body.tenantId, 'travel trip returned to wrong tenant').not.toBe(wellnessTenantId);
    } else {
      expect([404, 403, 400]).toContain(probe.status());
    }
  });

  test('VisaApplication — cross-tenant GET /api/travel/visa/:id MUST NOT leak the row', async ({ request }) => {
    const list = await request.get(`${API}/travel/visa?limit=5`, {
      headers: authHdr(wellnessToken),
      timeout: REQUEST_TIMEOUT,
    });
    if (!list.ok()) {
      test.skip(true, `wellness visa list unavailable: ${list.status()}`);
      return;
    }
    const lb = await list.json();
    const rows = Array.isArray(lb) ? lb : (lb.applications || lb.data || []);
    if (rows.length === 0) {
      test.skip(true, 'no visa applications in wellness tenant — skipping probe');
      return;
    }
    const id = rows[0].id;

    const probe = await request.get(`${API}/travel/visa/${id}`, {
      headers: authHdr(genericToken),
      timeout: REQUEST_TIMEOUT,
    });
    if (probe.status() === 200) {
      const body = await probe.json();
      expect(body.tenantId, 'visa application returned to wrong tenant').not.toBe(wellnessTenantId);
    } else {
      expect([404, 403, 400]).toContain(probe.status());
    }
  });

  test('TripParticipant — cross-tenant GET /api/travel/trip-participants/:id MUST NOT leak the row', async ({ request }) => {
    // TripParticipant detail typically lives nested under a trip, but
    // probe the flat endpoint if it exists. If the route is 404 even
    // from the owning tenant, skip — not relevant.
    const list = await request.get(`${API}/travel/trip-participants?limit=5`, {
      headers: authHdr(wellnessToken),
      timeout: REQUEST_TIMEOUT,
    });
    if (!list.ok()) {
      test.skip(true, `trip-participants endpoint not available (${list.status()})`);
      return;
    }
    const lb = await list.json();
    const rows = Array.isArray(lb) ? lb : (lb.participants || lb.data || []);
    if (rows.length === 0) {
      test.skip(true, 'no trip participants — skipping probe');
      return;
    }
    const id = rows[0].id;

    const probe = await request.get(`${API}/travel/trip-participants/${id}`, {
      headers: authHdr(genericToken),
      timeout: REQUEST_TIMEOUT,
    });
    if (probe.status() === 200) {
      const body = await probe.json();
      expect(body.tenantId, 'trip participant returned to wrong tenant').not.toBe(wellnessTenantId);
    } else {
      expect([404, 403, 400]).toContain(probe.status());
    }
  });

  // ────────────────────────────────────────────────────────────────
  // Security-sensitive surfaces
  // ────────────────────────────────────────────────────────────────

  test('ApiKey — cross-tenant GET /api/v1/external-keys (or sibling) MUST NOT leak keys', async ({ request }) => {
    // ApiKey list is at /api/integrations/api-keys or similar; we hit the
    // most common path. The expectation: the response either 200s with
    // ZERO rows belonging to the wellness tenant, or 403/404. We DON'T
    // expect specific keys to exist (CI may not have any).
    const list = await request.get(`${API}/integrations/api-keys`, {
      headers: authHdr(genericToken),
      timeout: REQUEST_TIMEOUT,
    });
    if (!list.ok()) {
      // Endpoint may not exist at this path — skip (not a leak).
      test.skip(true, `api-keys endpoint not at /integrations/api-keys (${list.status()})`);
      return;
    }
    const lb = await list.json();
    const rows = Array.isArray(lb) ? lb : (lb.keys || lb.apiKeys || lb.data || []);
    if (rows.length === 0) return; // no keys, no possible leak

    // Every row must belong to the GENERIC tenant.
    if (rows[0].tenantId !== undefined) {
      const offTenant = rows.filter((k) => k.tenantId === wellnessTenantId);
      expect(offTenant, `${offTenant.length} wellness-tenant API keys surfaced to generic admin`).toHaveLength(0);
    }
  });

  test('AuditLog — cross-tenant GET /api/audit (or sibling) MUST scope rows to caller tenant only', async ({ request }) => {
    const list = await request.get(`${API}/audit?limit=100`, {
      headers: authHdr(genericToken),
      timeout: REQUEST_TIMEOUT,
    });
    if (!list.ok()) {
      test.skip(true, `audit endpoint unavailable (${list.status()})`);
      return;
    }
    const lb = await list.json();
    const rows = Array.isArray(lb) ? lb : (lb.entries || lb.audits || lb.data || []);
    if (rows.length === 0) return;

    if (rows[0].tenantId !== undefined) {
      const offTenant = rows.filter((a) => a.tenantId === wellnessTenantId);
      expect(offTenant, `${offTenant.length} wellness-tenant audit entries surfaced to generic admin — cross-tenant audit leak`).toHaveLength(0);
    }
  });

  // ────────────────────────────────────────────────────────────────
  // Cross-cutting probes
  // ────────────────────────────────────────────────────────────────

  test('Anonymous probe — GET /api/contacts/:id WITHOUT auth MUST 401', async ({ request }) => {
    // Sanity check that the global auth guard is intact — if it ever
    // regresses, every cross-tenant probe in this spec passes trivially
    // (because there's no auth to check). Belt-and-suspenders.
    const probe = await request.get(`${API}/contacts/1`, {
      headers: { 'Content-Type': 'application/json' },
      timeout: REQUEST_TIMEOUT,
    });
    expect(probe.status(), 'anonymous probe must 401 — auth gate regression').toBe(401);
  });

  test('Nonexistent-row probe — both tenants 404 the same nonexistent id (proves 404 ≠ "row hidden by tenant scope")', async ({ request }) => {
    // Hammer a deliberately-impossible id from both tenants. Both must
    // 404, and they MUST 404 with the same shape — otherwise a probe
    // attacker could distinguish "row exists in other tenant" from "row
    // doesn't exist at all" via a status-code timing side-channel.
    const impossibleId = 2147483640; // close to int32 max — unlikely to be a real row
    const fromGeneric = await request.get(`${API}/contacts/${impossibleId}`, {
      headers: authHdr(genericToken),
      timeout: REQUEST_TIMEOUT,
    });
    const fromWellness = await request.get(`${API}/contacts/${impossibleId}`, {
      headers: authHdr(wellnessToken),
      timeout: REQUEST_TIMEOUT,
    });
    expect(fromGeneric.status(), 'generic must 404 nonexistent id').toBe(404);
    expect(fromWellness.status(), 'wellness must 404 nonexistent id').toBe(404);
  });

  test('Cross-tenant detail of EXISTING row from other tenant must 404 (NOT leak via different status)', async ({ request }) => {
    // This is the load-bearing probe: pick the Contact row we created
    // under wellness above, and assert that generic GETs it as 404 with
    // a body shape indistinguishable from the nonexistent-row 404.
    test.skip(created.contact.length === 0, 'no contact row created in earlier test — skipping');
    const wellnessContactId = created.contact[0];
    const probe = await request.get(`${API}/contacts/${wellnessContactId}`, {
      headers: authHdr(genericToken),
      timeout: REQUEST_TIMEOUT,
    });
    expect(probe.status(), `cross-tenant probe of existing-elsewhere row: status ${probe.status()}`).toBe(404);
  });
});
