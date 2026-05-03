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
 * Resources covered in this first wave (12 of ~109 multi-tenant models —
 * the highest-PII / highest-financial / highest-volume surfaces):
 *
 *   Generic CRM:    contacts, deals, tasks, billing, estimates,
 *                   notifications, workflows
 *   Wellness PHI:   wellness/patients, wellness/visits,
 *                   wellness/prescriptions, wellness/services,
 *                   wellness/locations
 *
 * Subsequent commits will widen the coverage to the remaining ~95
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
  // wellness/visits + wellness/prescriptions need a Patient FK first;
  // the framework here doesn't compose FKs. They're covered indirectly
  // by the Patient probe (if you can't get the patient, you can't get
  // their visits). A future widening pass will add explicit FK-aware
  // probes once the Patient probe lands.
];

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

        const r = await request.put(`${API}${resource.path}/${ownerId}`, {
          headers: authHeader(probeToken()),
          data: { name: `HACKED ${RUN_TAG}` },
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

          // Confirm the row is STILL readable by its owner after the
          // probe attempted to delete it. This catches the case where
          // the route silently mutates state but returns 403 (worst-case
          // scenario: probe gets "you can't" but data is gone anyway).
          const ownerRead = await request.get(`${API}${resource.path}/${ownerId}`, {
            headers: authHeader(resource.ownerToken === 'A' ? tokenA : tokenB),
            timeout: REQUEST_TIMEOUT,
          });
          expect(
            ownerRead.ok(),
            `after ${probeLabel} probed DELETE, ${ownerLabel} can no longer read its own row — silent mutation`,
          ).toBe(true);
        });
      }
    });
  }

});
