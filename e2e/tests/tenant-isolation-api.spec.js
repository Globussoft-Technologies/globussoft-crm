// @ts-check
/**
 * Tenant isolation — API gate (G-20)
 *
 * The single highest-severity bug class for a multi-tenant CRM: data
 * leaking across tenant boundaries. This spec asserts that **every
 * tenant-scoped resource** returns 404 (or 403 for cross-vertical
 * gates) when one tenant's admin tries to read/mutate another tenant's
 * row by ID. A 200 with a foreign tenant's data is the failure mode.
 *
 * The contract this spec locks down:
 *   1. **List endpoints** — Tenant B's list count does not change after
 *      Tenant A creates a row. (The list itself doesn't leak into B.)
 *   2. **GET /:id** — Tenant B GET on Tenant A's id → [403, 404].
 *      Never 200.
 *   3. **PUT /:id**  — Tenant B PUT on Tenant A's id  → [403, 404].
 *      Never 200 with the row mutated.
 *   4. **DELETE /:id** (when supported) — Tenant B DELETE on Tenant A's
 *      id → [403, 404]. The row is still readable by Tenant A after.
 *
 * Resources covered (G-20 wave 1 + wave 2 + wave 3 = ~25 of ~109 multi-tenant
 * models — the highest-PII / highest-financial / highest-volume
 * surfaces):
 *
 *   Generic CRM:    contacts, deals, tasks, billing, estimates,
 *                   workflows, sequences, projects, tickets,
 *                   developer-webhooks, scheduled-emails,
 *                   expenses, contracts, currencies,
 *                   custom-objects/entities, kb-articles, kb-categories,
 *                   scim-tokens
 *   Wellness PHI:   wellness/patients, wellness/services,
 *                   wellness/locations, wellness/visits,
 *                   wellness/prescriptions, wellness/consents,
 *                   wellness/treatment-plans
 *
 * Wave 2 added the wellness clinical FK chain (Patient → Visit →
 * Prescription, plus Patient → Consent). Those sub-resources need an
 * upstream Patient (and Visit, for Rx) seeded in the owner tenant
 * first; see `wellnessFk.*` below for the shared-upstream pattern used
 * by their `createBody`.
 *
 * Wave 3 (this commit) widens coverage with billing-adjacent +
 * platform-config surfaces (expenses, contracts, currencies, custom
 * entities, KB articles + categories, SCIM tokens) plus the wellness
 * treatment-plans clinical resource (which joins the no-delete cluster
 * per #21). Notable shapes:
 *   - `currencies`     creates a non-base row so DELETE is allowed.
 *   - `scim-tokens`    POST + DELETE only (no GET/:id, no PUT/:id) —
 *                      same shape class as developer-webhooks.
 *   - `wellness/treatment-plans` PUT only accepts `status`, so the
 *                      framework's cleanup PUT-rename is best-effort
 *                      and silently no-ops (acceptable: the seeded
 *                      `IsoTest…` name doesn't match demo-hygiene's
 *                      residue regex, so no pollution surfaces).
 *
 * Subsequent commits will widen the coverage to the remaining ~80+
 * tenant-scoped models. The framework here (`probeIsolation`) is the
 * load-bearing piece — adding a new resource is one entry in the
 * RESOURCES array.
 *
 * Tenant fixtures (seeded by prisma/seed.js + prisma/seed-wellness.js):
 *   admin@globussoft.com  →  Tenant A (generic, id=1, USD)
 *   admin@wellness.demo   →  Tenant B (wellness, id=2, INR)
 *
 * Both directions are tested for each resource: A→probes-B AND B→probes-A.
 * Symmetry matters because vertical gates (`/wellness/*`) only fire one
 * direction and we want to assert NEITHER direction leaks regardless of
 * which gate trips first.
 *
 * Revert-and-prove: temporarily strip the `tenantId` filter from any
 * route's `findFirst` / `findMany` (e.g. `routes/contacts.js GET /:id`),
 * commit on a throwaway branch, run this spec — it should go red on the
 * affected resource. That proves the gate has teeth.
 *
 * Cleanup: every row created here is tagged with `RUN_TAG` for human
 * traceability and explicitly DELETEd in afterAll. No reliance on
 * global-teardown.js (which doesn't run in mid-suite e2e-full).
 *
 * Closes regression risk for the cluster behind #408 (audit role guard,
 * was leaking PII across tenants), #409 (integrations toggle), #324
 * (doctor sees other clinicians' visits), #325 (generic admin saw
 * wellness dashboard), #403 (wellness admin sees Tenant B tasks), and
 * generally the whole "G-24 schema invariant" surface.
 */
const { test, expect } = require('@playwright/test');

// Pin to serial — the list-endpoint sweep (bottom of file) tests for the
// presence of a row that's created in a per-describe `beforeAll` higher
// up. Under playwright.config's `fullyParallel: true`, parallel shuffle
// could run the list test before the row exists → false-negative ("no
// leak" when actually we just hadn't seeded yet). Serial keeps the
// create-and-probe ordering tight and the suite is small enough that
// the perf cost is negligible.
test.describe.configure({ mode: 'serial' });

const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:5000';
const API = `${BASE_URL}/api`;
const REQUEST_TIMEOUT = 30000;
const RUN_TAG = `E2E_ISO_${Date.now()}`;

// ── Tenant fixtures ────────────────────────────────────────────────
const TENANT_A = { email: 'admin@globussoft.com', password: 'password123' };  // generic
const TENANT_B = { email: 'admin@wellness.demo', password: 'password123' };   // wellness

let tokenA = null;
let tokenB = null;
let userIdA = null;
let userIdB = null;

async function login(request, fixture) {
  const r = await request.post(`${API}/auth/login`, {
    data: fixture,
    headers: { 'Content-Type': 'application/json' },
    timeout: REQUEST_TIMEOUT,
  });
  if (!r.ok()) return null;
  return r.json();
}

function authHeader(token) {
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

// ── Resource catalog ───────────────────────────────────────────────
//
// Each entry describes one tenant-scoped HTTP resource and how to
// drive it. The framework loops over this and emits a parametrised
// describe block per resource.
//
// Fields:
//   name           — human label for test report
//   path           — HTTP path under /api/ (e.g. '/contacts', '/wellness/patients')
//   createBody     — () => POST body. Must include enough fields to pass
//                    server-side validation in BOTH tenants. Returns a
//                    fresh object each call so tags/timestamps stay unique.
//   ownerToken     — 'A' or 'B' — which tenant owns the seeded row.
//                    Defaults to 'A'. Use 'B' for wellness-only resources
//                    where Tenant A's POST would 403 on the vertical gate
//                    before the row is even created.
//   supportsDelete — true if DELETE /:id exists. Wellness clinical rows
//                    (Patient, Visit, Prescription, ConsentForm) follow
//                    a no-delete policy per issue #21.
//   listKey        — when the GET / response wraps rows in an envelope
//                    (e.g. `{ patients: [...] }`), this is the array key.
//                    null for routes that return the bare array.
//   skipPostBody   — true if the create endpoint takes a different body
//                    shape that this generic flow can't drive (rare;
//                    usually means the resource is read-mostly or
//                    requires an upstream FK that's expensive to seed).
//   mutateBody     — optional () => body for the PUT-probe step. Defaults
//                    to `{ name: 'HACKED <RUN_TAG>' }`. Override when the
//                    route's PUT validates required body fields BEFORE
//                    its tenant-scoped findFirst (e.g. wellness/treatment-plans
//                    requires `status` and 400s if missing — that 400
//                    would falsely fail the [403, 404] assertion even
//                    though no leak occurred). Pass a body that satisfies
//                    the validators so the request reaches the tenant
//                    check and the route returns the expected 404.
const RESOURCES = [
  // ── Generic CRM resources (Tenant A creates; Tenant B probes) ──────
  {
    name: 'contacts',
    path: '/contacts',
    createBody: () => ({
      name: `IsoTest ${RUN_TAG}`,
      email: `iso-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`,
      status: 'Lead',
    }),
    ownerToken: 'A',
    supportsDelete: true,
    listKey: null,
  },
  {
    name: 'deals',
    path: '/deals',
    createBody: () => ({
      title: `IsoTest Deal ${RUN_TAG}`,
      amount: 1000,
      stage: 'lead',
      probability: 50,
    }),
    ownerToken: 'A',
    supportsDelete: true,
    listKey: null,
  },
  {
    name: 'tasks',
    path: '/tasks',
    createBody: () => ({
      title: `IsoTest Task ${RUN_TAG}`,
      description: 'cross-tenant probe',
      status: 'pending',
      priority: 'medium',
    }),
    ownerToken: 'A',
    supportsDelete: true,
    listKey: null,
  },
  {
    name: 'billing',
    path: '/billing',
    createBody: () => ({
      invoiceNumber: `INV-${RUN_TAG}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`,
      amount: 500,
      status: 'pending',
      dueDate: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    }),
    ownerToken: 'A',
    supportsDelete: false,  // billing uses /void state machine, not hard DELETE
    cleanupField: 'invoiceNumber',  // rename via PUT to evade demo-hygiene residue regex
    listKey: null,
  },
  {
    name: 'estimates',
    path: '/estimates',
    createBody: () => ({
      title: `IsoTest Estimate ${RUN_TAG}`,
      lineItems: [{ name: 'Probe item', quantity: 1, unitPrice: 100 }],
      validUntil: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    }),
    ownerToken: 'A',
    supportsDelete: true,
    listKey: null,
  },
  // notifications has a different POST shape (targetUserId etc.) and
  // its tenant-isolation is exhaustively covered in notifications-api.spec.js;
  // skip here to avoid duplication.

  // ── Wellness PHI resources (Tenant B creates; Tenant A probes) ─────
  {
    name: 'wellness/patients',
    path: '/wellness/patients',
    createBody: () => ({
      name: `IsoTest Patient ${RUN_TAG}`,
      phone: `+9197${(Date.now() % 100000000).toString().padStart(8, '0')}`,
      source: 'walk-in',
    }),
    ownerToken: 'B',
    supportsDelete: false,         // clinical no-delete policy (#21)
    cleanupField: 'name',          // rename via PUT to clear residue marker
    listKey: 'patients',
  },
  {
    name: 'wellness/services',
    path: '/wellness/services',
    createBody: () => ({
      name: `IsoTest Service ${RUN_TAG} ${Math.random().toString(36).slice(2, 6)}`,
      category: 'consultation',
      ticketTier: 'low',
      basePrice: 500,
      durationMin: 30,
    }),
    ownerToken: 'B',
    supportsDelete: false,
    cleanupField: 'name',
    listKey: null,
  },
  {
    name: 'wellness/locations',
    path: '/wellness/locations',
    createBody: () => ({
      name: `IsoTest Location ${RUN_TAG} ${Math.random().toString(36).slice(2, 6)}`,
      addressLine: 'Test address',
      city: 'Test City',
      state: 'Test State',
      pincode: '999999',
      phone: `+9198${(Date.now() % 100000000).toString().padStart(8, '0')}`,
    }),
    ownerToken: 'B',
    supportsDelete: false,
    cleanupField: 'name',
    listKey: null,
  },
  // ── Wellness clinical FK chain (Tenant B creates; Tenant A probes) ─
  //
  // Visits, prescriptions and consents all reference a Patient FK
  // (Rx additionally needs a Visit FK). The framework's per-resource
  // `createBody()` is called at test time, *after* the outer
  // `beforeAll` has already populated `wellnessFk.{patientId,visitId}`
  // by POSTing one Patient + one Visit into Tenant B. If either seed
  // step fails, `wellnessFk.*` stays null and the affected describe
  // block's `createInOwnerTenant` short-circuits — the spec then
  // skips with a "POST … did not return a usable id" message rather
  // than blowing up. Same graceful-degrade discipline as the rest of
  // the catalog.
  {
    name: 'wellness/visits',
    path: '/wellness/visits',
    createBody: () => ({
      patientId: wellnessFk.patientId,
      // 'booked' status sidesteps the #109 service+doctor requirement
      // for completed visits — we only need a row that exists in
      // tenant B, the visit's clinical content is irrelevant to a
      // tenant-isolation probe.
      status: 'booked',
      notes: `IsoTest Visit ${RUN_TAG}`,
      visitDate: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    }),
    ownerToken: 'B',
    supportsDelete: false,         // clinical no-delete policy (#21)
    cleanupField: 'notes',
    listKey: null,
  },
  {
    name: 'wellness/prescriptions',
    path: '/wellness/prescriptions',
    createBody: () => ({
      visitId: wellnessFk.visitId,
      patientId: wellnessFk.patientId,
      // #114: drugs must be a non-empty array of named entries.
      drugs: [{ name: `IsoRxDrug ${RUN_TAG}`, dosage: '1 tab', frequency: 'BD', duration: '7d' }],
      instructions: `IsoTest Rx ${RUN_TAG}`,
    }),
    ownerToken: 'B',
    supportsDelete: false,         // clinical no-delete policy (#21)
    cleanupField: 'instructions',  // PUT only allows drugs/instructions amends
    listKey: null,
  },
  {
    name: 'wellness/consents',
    path: '/wellness/consents',
    createBody: () => ({
      patientId: wellnessFk.patientId,
      templateName: `IsoTest Consent ${RUN_TAG}`,
      // #118 defense-in-depth: signatureSvg must be ≥500 chars (a
      // blank canvas is ~220, a real signature is several KB). Pad
      // a minimal data-URL to clear the floor.
      signatureSvg: `data:image/svg+xml;base64,${'A'.repeat(600)}`,
    }),
    ownerToken: 'B',
    supportsDelete: false,         // clinical no-delete policy (#21)
    cleanupField: 'templateName',  // signatureSvg is post-sign-immutable per #118
    listKey: null,
  },

  // ── Generic CRM (wave 2) ───────────────────────────────────────────
  {
    name: 'workflows',
    path: '/workflows',
    createBody: () => ({
      name: `IsoTest Workflow ${RUN_TAG}`,
      // The route validates triggerType + actionType against a
      // whitelist (#18). Pick the most universally-supported pair:
      // contact.created → send_email is always present.
      triggerType: 'contact.created',
      actionType: 'send_email',
      targetState: { to: 'iso@example.test', subject: 'probe', body: 'probe' },
    }),
    ownerToken: 'A',
    supportsDelete: true,
    listKey: null,
  },
  {
    name: 'sequences',
    path: '/sequences',
    createBody: () => ({
      name: `IsoTest Sequence ${RUN_TAG}`,
      // #395: nodes must be an array (may be empty for a draft canvas).
      nodes: [],
      edges: [],
    }),
    ownerToken: 'A',
    supportsDelete: true,
    listKey: null,
  },
  {
    name: 'projects',
    path: '/projects',
    createBody: () => ({
      name: `IsoTest Project ${RUN_TAG}`,
      description: 'cross-tenant probe',
      priority: 'Medium',
    }),
    ownerToken: 'A',
    supportsDelete: true,
    listKey: null,
  },
  {
    name: 'tickets',
    path: '/tickets',
    createBody: () => ({
      subject: `IsoTest Ticket ${RUN_TAG}`,
      description: 'cross-tenant probe',
      priority: 'Low',
    }),
    ownerToken: 'A',
    supportsDelete: true,
    listKey: null,
  },
  {
    // POST + DELETE only — there is no GET /:id or PUT /:id at
    // /developer/webhooks. The framework's id-targeted GET/PUT probes
    // therefore land on a non-existent route and return 404, which
    // satisfies [403, 404]. The list-leak test is the meaningful gate
    // here: tenant B's webhook list must NEVER include tenant A's row
    // (and the route additionally scopes by userId, which makes leak
    // doubly unlikely — a regression that drops EITHER filter is
    // caught).
    name: 'developer-webhooks',
    path: '/developer/webhooks',
    createBody: () => ({
      event: 'contact.created',
      // RUN_TAG embedded in the URL path so the list-scan regex picks
      // it up if a leak ever happens.
      targetUrl: `https://example.test/iso/${RUN_TAG}/${Math.random().toString(36).slice(2, 8)}`,
    }),
    ownerToken: 'A',
    supportsDelete: true,
    listKey: null,
  },
  {
    // POST + GET/:id + DELETE/:id exist; PUT/:id does NOT (the route
    // exposes /cancel and /send-now action verbs instead). Probe-side
    // PUT 404s are acceptable [403, 404]. List uses scheduledFor
    // window (next 7 days by default) — our seed is +1d so it lands
    // inside that window without `?all=`.
    name: 'scheduled-emails',
    path: '/email-scheduling',
    createBody: () => ({
      to: `iso-${Date.now()}@example.test`,
      subject: `IsoTest Scheduled ${RUN_TAG}`,
      body: `cross-tenant probe ${RUN_TAG}`,
      scheduledFor: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    }),
    ownerToken: 'A',
    supportsDelete: true,
    listKey: null,
  },

  // ── Generic CRM (wave 3) ───────────────────────────────────────────
  {
    name: 'expenses',
    path: '/expenses',
    createBody: () => ({
      title: `IsoTest Expense ${RUN_TAG}`,
      amount: 250.00,
      category: 'Travel',
      notes: 'cross-tenant probe',
    }),
    ownerToken: 'A',
    supportsDelete: true,
    listKey: null,
  },
  {
    name: 'contracts',
    path: '/contracts',
    createBody: () => ({
      title: `IsoTest Contract ${RUN_TAG}`,
      status: 'Draft',
      value: 10000,
      terms: 'cross-tenant probe',
      startDate: new Date().toISOString(),
      endDate: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
    }),
    ownerToken: 'A',
    supportsDelete: true,
    listKey: null,
  },
  {
    // routes/currencies.js: full CRUD. CAUTION — DELETE refuses (400) on
    // the tenant base currency; we explicitly create with isBase=false so
    // the framework's owner-side DELETE cleanup path is allowed. Code
    // chosen at random per-call to avoid the per-tenant unique-code
    // constraint colliding across runs in the same MySQL second.
    name: 'currencies',
    path: '/currencies',
    createBody: () => ({
      // 3-letter ISO-ish code; not a real currency, won't collide with seeds.
      code: `Z${Math.random().toString(36).slice(2, 4).toUpperCase()}`,
      symbol: '¤',
      name: `IsoTest Currency ${RUN_TAG}`,
      exchangeRate: 1.0,
      isBase: false,
    }),
    ownerToken: 'A',
    supportsDelete: true,
    listKey: null,
  },
  {
    // routes/custom_objects.js entities surface — full CRUD added in
    // #419 (commit b90ac7c). The seed creates an entity with no records
    // so DELETE /:id is allowed (the route 409s with ENTITY_HAS_RECORDS
    // when records exist; we don't hit that path).
    //
    // Path quirk: the list endpoint is /custom-objects/entities but the
    // by-id endpoints are /custom-objects/entities/:id. The framework's
    // template `${path}/${id}` resolves to the latter; the list-leak
    // probe hits the former (with `?limit=500` ignored — list returns
    // unbounded array, which the framework treats as a flat array
    // since listKey is null).
    name: 'custom-objects/entities',
    path: '/custom-objects/entities',
    createBody: () => ({
      // NAME_MAX is 100 chars — RUN_TAG plus a tiny salt fits comfortably.
      name: `IsoTest Entity ${RUN_TAG} ${Math.random().toString(36).slice(2, 6)}`,
      description: 'cross-tenant probe',
      fields: [{ name: 'TestField', type: 'String' }],
    }),
    ownerToken: 'A',
    supportsDelete: true,
    listKey: null,
  },
  {
    // routes/knowledge_base.js articles surface. Slug is derived
    // server-side from title via slugify+ensureUniqueSlug, so we only
    // need to vary the title to keep slugs unique across runs.
    name: 'kb-articles',
    path: '/knowledge-base/articles',
    createBody: () => ({
      title: `IsoTest KB Article ${RUN_TAG} ${Math.random().toString(36).slice(2, 6)}`,
      content: 'cross-tenant probe body',
      isPublished: false,
    }),
    ownerToken: 'A',
    supportsDelete: true,
    listKey: null,
  },
  {
    // routes/knowledge_base.js categories surface. Same slug-from-name
    // generation as articles. DELETE detaches articles in the category
    // before the row drop, which is moot here since the category has
    // no articles.
    name: 'kb-categories',
    path: '/knowledge-base/categories',
    createBody: () => ({
      name: `IsoTest KB Cat ${RUN_TAG} ${Math.random().toString(36).slice(2, 6)}`,
    }),
    ownerToken: 'A',
    supportsDelete: true,
    listKey: null,
  },
  {
    // routes/scim.js token-management surface (NOT the SCIM v2 endpoints,
    // which use a different bearer scheme). Same shape class as
    // developer-webhooks: POST + DELETE only — no GET/:id, no PUT/:id.
    // The framework's id-targeted GET/PUT probes therefore land on a
    // non-existent route and return 404 (which satisfies [403, 404]).
    // The list-leak probe is the meaningful gate here: tenant B's
    // /scim/tokens list must NEVER include tenant A's token row.
    name: 'scim-tokens',
    path: '/scim/tokens',
    createBody: () => ({
      // Token name is the only writable field; embed RUN_TAG so the
      // list-leak probe's tag-scan picks it up. The route returns the
      // hashed token's mask (scim_••••••••XXXX), not plaintext, so we
      // can't tag the value column — name is enough.
      name: `IsoTest SCIM Token ${RUN_TAG} ${Math.random().toString(36).slice(2, 6)}`,
    }),
    ownerToken: 'A',
    supportsDelete: true,
    listKey: null,
  },

  // ── Wellness clinical (wave 3) ─────────────────────────────────────
  {
    // routes/wellness.js treatment-plans (#420 consolidated path,
    // commit cea9bc0). PUT only accepts `status` (per
    // controllers/treatmentPlanController.js), so the framework's
    // cleanup PUT-rename is a best-effort no-op — that's acceptable
    // because `IsoTest…` doesn't match demo-hygiene's residue regex
    // (e2e/test-data-patterns.js anchors on E2E_, Race, PHI Audit,
    // etc.; our marker is the suffix RUN_TAG, never the prefix).
    //
    // Joins the clinical-no-delete cluster per #21: no DELETE
    // endpoint exists for the resource, so supportsDelete=false.
    // patientId FK pulls from the shared wellnessFk seed populated in
    // the outer beforeAll.
    name: 'wellness/treatment-plans',
    path: '/wellness/treatment-plans',
    createBody: () => ({
      patientId: wellnessFk.patientId,
      name: `IsoTest Treatment Plan ${RUN_TAG}`,
      totalSessions: 5,
      totalPrice: 5000,
    }),
    // Controller validates `status` before tenant scope (see
    // controllers/treatmentPlanController.js#updateTreatmentPlan); without
    // this override the cross-tenant probe would 400 on missing status
    // rather than 404 on tenant miss. Status string is harmless on a
    // 404 path — the row is never reached.
    mutateBody: () => ({ status: 'active' }),
    ownerToken: 'B',
    supportsDelete: false,         // clinical no-delete policy (#21)
    // No cleanupField — PUT only accepts `status` (would set it to a
    // junk value like `_teardown_iso_<id>`), and `name` is not in the
    // PUT whitelist so we can't rename. That's acceptable here:
    // `IsoTest Treatment Plan …` doesn't match demo-hygiene's residue
    // regex (e2e/test-data-patterns.js anchors on E2E_, Race, PHI Audit,
    // etc.). Row is left in place; downstream cleanup is a manual ops
    // task if it ever matters.
    listKey: null,
  },
];

// ── Wellness FK chain seed ─────────────────────────────────────────
//
// Visits + prescriptions + consents all need at least a Patient FK
// (Rx also needs a Visit FK). Rather than seeding inside each
// resource's beforeAll (which would create N redundant patients and
// burn audit-log volume), we seed ONE Patient + ONE Visit in the
// outer beforeAll and have the wellness/{visits,prescriptions,consents}
// createBody factories pull from this shared object.
//
// Owner tenant is B (wellness). If seeding fails (route 5xx, schema
// mismatch, anything), the resource's createInOwnerTenant returns
// null and the per-resource probes skip with a clear message — same
// graceful-degrade contract as the rest of the catalog. Cleanup is
// handled by per-resource afterAll for the leaf rows; the upstream
// Patient + Visit are renamed in the wellness-FK afterAll below to
// clear the RUN_TAG marker (clinical rows are no-delete per #21).
const wellnessFk = {
  patientId: null,
  visitId: null,
};

// ── Probe helpers ──────────────────────────────────────────────────

/**
 * Create a row in the owner tenant. Returns the created id, or null if
 * the create failed (skip the rest of the probe with a descriptive
 * message; the spec is informational, not aspirational).
 */
async function createInOwnerTenant(request, resource) {
  const ownerToken = resource.ownerToken === 'A' ? tokenA : tokenB;
  if (!ownerToken) return null;
  const res = await request.post(`${API}${resource.path}`, {
    headers: authHeader(ownerToken),
    data: resource.createBody(),
    timeout: REQUEST_TIMEOUT,
  });
  if (!res.ok()) return null;
  const body = await res.json();
  return body && typeof body.id === 'number' ? body.id : null;
}

/**
 * Best-effort cleanup.
 *   - DELETE if `supportsDelete: true`.
 *   - Otherwise, if `cleanupField` is set, PUT-rename the row's
 *     identifying field to `_teardown_iso_<id>`. That clears the
 *     RUN_TAG marker out of name/title/invoiceNumber so subsequent
 *     demo-hygiene scans don't trip on it. Pattern mirrors what
 *     wellness-clinical-api.spec.js does for Locations (commit
 *     `02a4d1e`).
 *   - Otherwise, leave the row (and accept demo accumulation; this
 *     branch shouldn't be hit by any current resource).
 *
 * Failures are swallowed — cleanup is best-effort, the spec already
 * reported pass/fail by this point.
 */
async function cleanupOwnerRow(request, resource, id) {
  if (id == null) return;
  const ownerToken = resource.ownerToken === 'A' ? tokenA : tokenB;
  if (!ownerToken) return;

  if (resource.supportsDelete) {
    await request.delete(`${API}${resource.path}/${id}`, {
      headers: authHeader(ownerToken),
      timeout: REQUEST_TIMEOUT,
    }).catch(() => {});
    return;
  }

  if (resource.cleanupField) {
    await request.put(`${API}${resource.path}/${id}`, {
      headers: authHeader(ownerToken),
      data: { [resource.cleanupField]: `_teardown_iso_${id}` },
      timeout: REQUEST_TIMEOUT,
    }).catch(() => {});
  }
}

// ── Spec body ──────────────────────────────────────────────────────

test.describe('Tenant isolation — API gate (G-20)', () => {
  test.beforeAll(async ({ request }) => {
    const a = await login(request, TENANT_A);
    const b = await login(request, TENANT_B);
    tokenA = a?.token || null;
    tokenB = b?.token || null;
    userIdA = a?.user?.id || null;
    userIdB = b?.user?.id || null;

    // ── Wellness FK seed (Tenant B) ──────────────────────────────
    // Best-effort. If any step fails, the dependent resources skip
    // with `wellnessFk.{patientId,visitId} == null` — the framework
    // already short-circuits createInOwnerTenant on a falsy POST,
    // which propagates `ownerId == null` and skips the leaf probes.
    if (tokenB) {
      try {
        const patientRes = await request.post(`${API}/wellness/patients`, {
          headers: authHeader(tokenB),
          data: {
            name: `IsoFk Patient ${RUN_TAG}`,
            phone: `+9197${(Date.now() % 100000000).toString().padStart(8, '0')}`,
            source: 'walk-in',
          },
          timeout: REQUEST_TIMEOUT,
        });
        if (patientRes.ok()) {
          const pBody = await patientRes.json();
          wellnessFk.patientId = pBody?.id ?? null;
        }
      } catch (_e) { /* swallow — leaf probes will skip */ }

      if (wellnessFk.patientId != null) {
        try {
          const visitRes = await request.post(`${API}/wellness/visits`, {
            headers: authHeader(tokenB),
            data: {
              patientId: wellnessFk.patientId,
              status: 'booked',
              notes: `IsoFk Visit ${RUN_TAG}`,
              visitDate: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
            },
            timeout: REQUEST_TIMEOUT,
          });
          if (visitRes.ok()) {
            const vBody = await visitRes.json();
            wellnessFk.visitId = vBody?.id ?? null;
          }
        } catch (_e) { /* swallow */ }
      }
    }
  });

  test.afterAll(async ({ request }) => {
    // Rename the FK-chain Patient + Visit rows to clear the RUN_TAG
    // marker so demo-hygiene's residue regex doesn't trip on them
    // post-suite. Clinical rows are no-delete per #21, so we PUT-rename
    // the same way wellness-clinical-api.spec.js does (commit 02a4d1e).
    // Failures swallowed — best-effort, by this point pass/fail is
    // already reported.
    if (tokenB && wellnessFk.visitId != null) {
      await request.put(`${API}/wellness/visits/${wellnessFk.visitId}`, {
        headers: authHeader(tokenB),
        data: { notes: `_teardown_iso_fk_visit_${wellnessFk.visitId}` },
        timeout: REQUEST_TIMEOUT,
      }).catch(() => {});
    }
    if (tokenB && wellnessFk.patientId != null) {
      await request.put(`${API}/wellness/patients/${wellnessFk.patientId}`, {
        headers: authHeader(tokenB),
        data: { name: `_teardown_iso_fk_patient_${wellnessFk.patientId}` },
        timeout: REQUEST_TIMEOUT,
      }).catch(() => {});
    }
  });

  test('beforeAll-sanity: both tenant logins succeeded', () => {
    test.skip(!tokenA || !tokenB, 'one or both tenant fixtures are not seeded in this env');
    expect(tokenA).toBeTruthy();
    expect(tokenB).toBeTruthy();
    // Sanity that they're different users (would've been catastrophic if seed
    // somehow collapsed both fixtures onto the same row).
    expect(userIdA).not.toBe(userIdB);
  });

  for (const resource of RESOURCES) {
    test.describe(`${resource.name}`, () => {
      let ownerId = null;
      const probeToken = () => (resource.ownerToken === 'A' ? tokenB : tokenA);
      const probeLabel = resource.ownerToken === 'A' ? 'tenant B' : 'tenant A';
      const ownerLabel = resource.ownerToken === 'A' ? 'tenant A' : 'tenant B';

      test.beforeAll(async ({ request }) => {
        if (!tokenA || !tokenB) return;
        ownerId = await createInOwnerTenant(request, resource);
      });

      test.afterAll(async ({ request }) => {
        await cleanupOwnerRow(request, resource, ownerId);
      });

      test(`${probeLabel} list does NOT include ${ownerLabel}'s row (${resource.path})`, async ({ request }) => {
        test.skip(!tokenA || !tokenB, 'tenant fixtures not seeded');
        test.skip(ownerId == null, `${ownerLabel} POST ${resource.path} did not return a usable id`);

        const r = await request.get(`${API}${resource.path}?limit=500`, {
          headers: authHeader(probeToken()),
          timeout: REQUEST_TIMEOUT,
        });
        // Vertical / RBAC gates can legitimately return 401/403 for
        // cross-vertical list access (e.g. tenant A on /wellness/*) —
        // that's perfect isolation; nothing to inspect.
        if (r.status() === 401 || r.status() === 403) return;
        expect(r.ok(), `list endpoint returned ${r.status()}`).toBe(true);

        const body = await r.json();
        const rows = resource.listKey
          ? (body[resource.listKey] || body.data || [])
          : (Array.isArray(body) ? body : (body.items || body.data || []));
        // Any row carrying RUN_TAG would be the owner-tenant's leaked row.
        const tagged = rows.filter((row) => JSON.stringify(row).includes(RUN_TAG));
        expect(
          tagged,
          `list endpoint returned ${rows.length} rows for probing ${probeLabel}; ${tagged.length} carry the owner tenant's RUN_TAG (${RUN_TAG}) — DATA LEAK`,
        ).toEqual([]);
      });

      test(`${probeLabel} GET ${resource.path}/:id → [403, 404] (no leak)`, async ({ request }) => {
        test.skip(!tokenA || !tokenB, 'tenant fixtures not seeded');
        test.skip(ownerId == null, `${ownerLabel} POST ${resource.path} did not return a usable id`);

        const r = await request.get(`${API}${resource.path}/${ownerId}`, {
          headers: authHeader(probeToken()),
          timeout: REQUEST_TIMEOUT,
        });
        expect(
          [403, 404].includes(r.status()),
          `${probeLabel} GET ${resource.path}/${ownerId} returned ${r.status()} — expected 403 or 404. Body: ${(await r.text()).slice(0, 200)}`,
        ).toBe(true);
      });

      test(`${probeLabel} PUT ${resource.path}/:id → [403, 404] (no mutation)`, async ({ request }) => {
        test.skip(!tokenA || !tokenB, 'tenant fixtures not seeded');
        test.skip(ownerId == null, `${ownerLabel} POST ${resource.path} did not return a usable id`);

        // Default probe body: a `name` rename. Some routes validate
        // required fields before the tenant-scoped findFirst (e.g.
        // wellness/treatment-plans requires `status`); they expose a
        // `mutateBody` factory that returns a body satisfying the
        // validators so the request reaches the tenant check and 404s
        // instead of 400ing on missing fields.
        const probeBody = resource.mutateBody
          ? resource.mutateBody()
          : { name: `HACKED ${RUN_TAG}` };

        const r = await request.put(`${API}${resource.path}/${ownerId}`, {
          headers: authHeader(probeToken()),
          data: probeBody,
          timeout: REQUEST_TIMEOUT,
        });
        expect(
          [403, 404].includes(r.status()),
          `${probeLabel} PUT ${resource.path}/${ownerId} returned ${r.status()} — expected 403 or 404`,
        ).toBe(true);
      });

      // DELETE is gated on resource.supportsDelete because (a) wellness
      // clinical rows have a hard no-delete policy per #21 and (b)
      // billing uses /void state machine instead of DELETE. In both
      // cases there's no DELETE endpoint to probe; skipping is correct.
      if (resource.supportsDelete) {
        test(`${probeLabel} DELETE ${resource.path}/:id → [403, 404]`, async ({ request }) => {
          test.skip(!tokenA || !tokenB, 'tenant fixtures not seeded');
          test.skip(ownerId == null, `${ownerLabel} POST ${resource.path} did not return a usable id`);

          const r = await request.delete(`${API}${resource.path}/${ownerId}`, {
            headers: authHeader(probeToken()),
            timeout: REQUEST_TIMEOUT,
          });
          expect(
            [403, 404].includes(r.status()),
            `${probeLabel} DELETE ${resource.path}/${ownerId} returned ${r.status()} — expected 403 or 404`,
          ).toBe(true);

          // Confirm the row is STILL accessible to its owner after the
          // probe attempted to delete it. Catches silent-mutation
          // variants: probe DELETE returns 403/404 BUT the row was
          // actually deleted server-side. We try GET /:id first; if the
          // resource doesn't have a by-id endpoint (developer-webhooks,
          // scim-tokens — list+POST+DELETE only), fall back to checking
          // the LIST response for the row's id. Either way, finding the
          // row post-DELETE proves no silent mutation occurred.
          // (NOTE: workflows used to live in this list pre-#418 — that
          //  route now has GET /:id, so it's no longer list-only.)
          const ownerToken = resource.ownerToken === 'A' ? tokenA : tokenB;
          const ownerRead = await request.get(`${API}${resource.path}/${ownerId}`, {
            headers: authHeader(ownerToken),
            timeout: REQUEST_TIMEOUT,
          });
          let stillThere;
          if (ownerRead.ok()) {
            stillThere = true;
          } else if (ownerRead.status() === 404) {
            // Could be: (a) silent-mutation bug → row really gone, OR
            // (b) the resource has no GET /:id at all. Disambiguate by
            // listing and looking for the id.
            const listRead = await request.get(`${API}${resource.path}?limit=500`, {
              headers: authHeader(ownerToken),
              timeout: REQUEST_TIMEOUT,
            });
            if (listRead.ok()) {
              const body = await listRead.json();
              const rows = resource.listKey
                ? (body[resource.listKey] || body.data || [])
                : (Array.isArray(body) ? body : (body.items || body.data || []));
              stillThere = rows.some((row) => row && row.id === ownerId);
            } else {
              // Owner can't even list — environment issue, not a leak signal. Skip.
              stillThere = true;
            }
          } else {
            // Some other status (5xx, transient) — skip the leak check rather than false-positive.
            stillThere = true;
          }
          expect(
            stillThere,
            `after ${probeLabel} probed DELETE, ${ownerLabel} can no longer find its own row (id=${ownerId}) via GET/:id or via list — silent mutation`,
          ).toBe(true);
        });
      }
    });
  }

});
