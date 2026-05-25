// @ts-check
/**
 * Cross-tenant IDOR probe — GH #919 slices 1 + 2.
 *
 * Issue #919's remediation: "Add a CI test suite: for every /api/* route,
 * seed two tenants A and B with one record each, then call the route with
 * A's JWT and B's ID and assert non-2xx." Slice 1 (ab8bcdbe) seeded
 * representative coverage across the Travel-vertical + cross-vertical
 * Contact surface. Slice 2 (this commit) extends the Travel-vertical
 * sweep to 6 additional /:id endpoints that landed after slice 1 was
 * authored, including the two routes that #5c48de2a unblocked by adding
 * their missing app.use() mounts (flyer-templates already covered in
 * slice 1; trips + diagnostics + suppliers + cost-master + rfu-profiles
 * + diagnostic-banks are the new sweep). Future slices expand to
 * additional /api/* routes (Patient, Visit, Prescription, Deal, Invoice,
 * etc.) on the same pattern.
 *
 * Slice 2 also pins the layered-guard-order contract for /api/travel/
 * trips/:id — the route mounts requireTravelTenant BEFORE
 * requireTmcAccess, so cross-vertical attackers must hit 403
 * WRONG_VERTICAL (the vertical guard) not 403 TMC_ACCESS_DENIED (the
 * sub-brand guard). A future refactor that re-orders the guards would
 * silently leak "this id exists in the travel tenant but you lack TMC
 * access" — a softer-form leak than the current vertical-first design.
 *
 * Three tenants are seeded by default in CI (deploy.yml `api_tests`):
 *   • generic   — admin@globussoft.com   (vertical=generic)
 *   • wellness  — admin@wellness.demo    (vertical=wellness)
 *   • travel    — yasin@travelstall.in   (vertical=travel)
 *
 * The probe contract pins TWO distinct cross-tenant defences and
 * deliberately keeps them separate because they live at different
 * middleware layers:
 *
 *   (1) Cross-vertical (Travel routes called by wellness/generic admin)
 *       → 403 WRONG_VERTICAL fires at requireTravelTenant BEFORE the
 *       id lookup runs. From an IDOR-prevention standpoint this is
 *       STRONGER than a 404, because the attacker cannot enumerate id
 *       existence at all — the guard never even reaches Prisma. We pin
 *       the 403 + WRONG_VERTICAL code so a future refactor that demotes
 *       this to a 404 (post-vertical-guard) doesn't silently weaken
 *       isolation by leaking which-id-exists information.
 *
 *   (2) Cross-tenant on shared cross-vertical models (Contact)
 *       → 404 fires inside the handler's prisma.contact.findFirst({
 *       where: { id, tenantId: req.user.tenantId } }) miss. This is
 *       the canonical "tenant filter in the WHERE clause" pattern the
 *       #919 remediation calls for. A 200 here would be the true IDOR
 *       leak; a 403 (with WHICH-tenant-owns leak) would be a softer
 *       leak. We pin 404 in both directions (wellness → generic
 *       Contact id AND generic → wellness Contact id) so the canonical
 *       cross-tenant 404 contract becomes a single-line CI signal.
 *
 * Drift note (per .claude/skills/verifying-gap-card-claims/SKILL.md):
 * the #919 prompt asserted "expect 404 NOT 200 NOT 403 leaking
 * which-tenant-owns" across ALL routes. Reality is that Travel routes
 * gate cross-vertical with 403 WRONG_VERTICAL — this is intentional
 * defense-in-depth (the vertical guard runs first, then tenant scope).
 * We PIN REALITY (403 + WRONG_VERTICAL for cross-vertical Travel
 * lookups) rather than the prompt's hypothesis, because the 403 here
 * is STRICTER than a 404 from a leak-surface perspective. The Contact
 * 404 contract matches the prompt verbatim.
 *
 * Probe shape per route:
 *   1. Authenticate the "attacker" admin.
 *   2. POST a sentinel id (id=1) — fresh demo seed always has id=1
 *      for tenant-1 rows; if id=1 doesn't exist on the target side, the
 *      cross-vertical 403 still fires (the guard doesn't care). For
 *      cross-tenant Contact probes we create our own row on the victim
 *      side so the id is guaranteed to exist.
 *   3. Attempt GET /:id with the attacker token.
 *   4. Assert the documented status + code shape (403 WRONG_VERTICAL
 *      or 404).
 *
 * Wire-in: parent will add this file to .github/workflows/deploy.yml
 * (per-push gate) AND .github/workflows/coverage.yml (coverage gate)
 * AFTER slice 1 lands. Do not touch the YAMLs from this spec's commit.
 *
 * RUN_TAG: E2E_IDOR_919_<ts> — afterAll() sweeps any contact rows the
 * spec created during the cross-tenant probe.
 */

const { test, expect } = require("@playwright/test");

test.describe.configure({ mode: "serial" });

const BASE_URL = process.env.BASE_URL || "https://crm.globusdemos.com";
const REQUEST_TIMEOUT = 60000;
const RUN_TAG = `E2E_IDOR_919_${Date.now()}`;

// ─── Token cache ─────────────────────────────────────────────────────
// All three tenants needed: generic + wellness + travel admin.
let genericAdminToken = null;
let wellnessAdminToken = null;
let travelAdminToken = null;

async function loginAs(request, email, password) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await request.post(`${BASE_URL}/api/auth/login`, {
        data: { email, password },
        headers: { "Content-Type": "application/json" },
        timeout: REQUEST_TIMEOUT,
      });
      if (r.ok()) return (await r.json()).token;
    } catch (_e) {
      if (attempt === 0) continue;
    }
  }
  return null;
}

async function getGenericAdmin(request) {
  if (!genericAdminToken) {
    genericAdminToken = await loginAs(request, "admin@globussoft.com", "password123");
  }
  return genericAdminToken;
}
async function getWellnessAdmin(request) {
  if (!wellnessAdminToken) {
    wellnessAdminToken = await loginAs(request, "admin@wellness.demo", "password123");
  }
  return wellnessAdminToken;
}
async function getTravelAdmin(request) {
  if (!travelAdminToken) {
    travelAdminToken = await loginAs(request, "yasin@travelstall.in", "password123");
  }
  return travelAdminToken;
}

const headers = (token) => ({
  Authorization: `Bearer ${token}`,
  "Content-Type": "application/json",
});

// Cloudflare-fronted demo occasionally surfaces transient 5xx during
// origin restarts. Same retry pattern as notifications-api.spec.js.
async function retryOn5xx(fn) {
  let r;
  for (let attempt = 0; attempt < 3; attempt++) {
    r = await fn();
    if (r.status() < 500) return r;
    await new Promise((res) => setTimeout(res, 500 * (attempt + 1)));
  }
  return r;
}

async function get(request, token, path) {
  return retryOn5xx(() =>
    request.get(`${BASE_URL}${path}`, {
      headers: headers(token),
      timeout: REQUEST_TIMEOUT,
    }),
  );
}
async function post(request, token, path, body) {
  return retryOn5xx(() =>
    request.post(`${BASE_URL}${path}`, {
      headers: headers(token),
      data: body ?? {},
      timeout: REQUEST_TIMEOUT,
    }),
  );
}
async function del(request, token, path) {
  return retryOn5xx(() =>
    request.delete(`${BASE_URL}${path}`, {
      headers: headers(token),
      timeout: REQUEST_TIMEOUT,
    }),
  );
}

// Track contact ids we create so afterAll() can sweep them. Each entry
// is { token, id } — token used to delete from the same tenant.
const createdContacts = [];

test.afterAll(async ({ request }) => {
  const deadline = Date.now() + 40_000;
  for (const { token, id } of createdContacts) {
    if (Date.now() > deadline) break;
    if (!token) continue;
    await del(request, token, `/api/contacts/${id}`).catch(() => {});
  }
});

// Helper — create a contact under the supplied admin token and return
// its id. The created id then becomes the "victim id" that the other
// tenant's admin attempts to read.
async function createContact(request, token, label) {
  const res = await post(request, token, "/api/contacts", {
    name: `${RUN_TAG} ${label}`,
    email: `${RUN_TAG.toLowerCase()}-${label}@e2e-idor-probe.local`,
  });
  expect(res.status(), `create contact (${label}): ${await res.text()}`).toBe(201);
  const body = await res.json();
  expect(body.id, `contact create response missing id`).toBeTruthy();
  createdContacts.push({ token, id: body.id });
  return body.id;
}

// ─── /api/contacts — true cross-tenant probe (same vertical model) ───
// Contact lives on every vertical. Cross-tenant must 404 (the canonical
// "tenant filter in WHERE clause" contract). Probe in BOTH directions
// so a future regression that only adds the filter to ONE direction is
// caught.

test.describe("IDOR #919 — /api/contacts/:id cross-tenant (canonical 404)", () => {
  test("wellness admin GETting a generic-tenant Contact id → 404", async ({ request }) => {
    const generic = await getGenericAdmin(request);
    const wellness = await getWellnessAdmin(request);
    if (!generic || !wellness) {
      test.skip(true, "generic + wellness admin tokens both required");
    }
    const victimId = await createContact(request, generic, "victim-on-generic");

    const res = await get(request, wellness, `/api/contacts/${victimId}`);
    expect(
      res.status(),
      `wellness admin must not read generic Contact id=${victimId}: got ${res.status()} (${await res.text()})`,
    ).toBe(404);
  });

  test("generic admin GETting a wellness-tenant Contact id → 404", async ({ request }) => {
    const generic = await getGenericAdmin(request);
    const wellness = await getWellnessAdmin(request);
    if (!generic || !wellness) {
      test.skip(true, "generic + wellness admin tokens both required");
    }
    const victimId = await createContact(request, wellness, "victim-on-wellness");

    const res = await get(request, generic, `/api/contacts/${victimId}`);
    expect(
      res.status(),
      `generic admin must not read wellness Contact id=${victimId}: got ${res.status()} (${await res.text()})`,
    ).toBe(404);
  });

  test("travel admin GETting a generic-tenant Contact id → 404", async ({ request }) => {
    const generic = await getGenericAdmin(request);
    const travel = await getTravelAdmin(request);
    if (!generic || !travel) {
      test.skip(true, "generic + travel admin tokens both required");
    }
    const victimId = await createContact(request, generic, "victim-on-generic-for-travel");

    const res = await get(request, travel, `/api/contacts/${victimId}`);
    expect(
      res.status(),
      `travel admin must not read generic Contact id=${victimId}: got ${res.status()} (${await res.text()})`,
    ).toBe(404);
  });

  test("404 body does NOT leak the existing-tenant id back to the caller", async ({ request }) => {
    // Sanity: the 404 response carries an error message but NOT a hint
    // that the row exists in another tenant. Any future regression that
    // changes the 404 body to "Contact exists but in tenant X" would
    // be a softer-form leak — pin against it here.
    const generic = await getGenericAdmin(request);
    const wellness = await getWellnessAdmin(request);
    if (!generic || !wellness) {
      test.skip(true, "generic + wellness admin tokens both required");
    }
    const victimId = await createContact(request, generic, "leak-shape");

    const res = await get(request, wellness, `/api/contacts/${victimId}`);
    expect(res.status()).toBe(404);
    const body = await res.json();
    const blob = JSON.stringify(body).toLowerCase();
    // No tenant-name / tenant-id hints; just a generic "not found" envelope.
    expect(blob).not.toMatch(/admin@globussoft|admin@wellness|yasin@travelstall/);
    expect(blob).not.toMatch(/generic[\s_-]?tenant|wellness[\s_-]?tenant|travel[\s_-]?tenant/);
  });
});

// ─── /api/travel/* — cross-vertical 403 WRONG_VERTICAL probe ─────────
// Every /api/travel route mounts requireTravelTenant (backend/middleware/
// travelGuards.js:33). For wellness + generic admin tokens this 403s
// BEFORE the id lookup runs. From an IDOR standpoint this is stricter
// than a 404 (no id-enumeration surface at all), so we pin it.
//
// Note: the probe uses a HIGH-NUMBER non-existent id (999999999). The
// guard fires regardless of whether the id exists — and using a fake
// id guarantees we're not accidentally testing a normal 404 path.

const FAKE_ID = 999999999;

test.describe("IDOR #919 — /api/travel/* cross-vertical (403 WRONG_VERTICAL)", () => {
  const TRAVEL_ROUTES = [
    // Slice 1 — original sweep.
    { path: `/api/travel/quotes/${FAKE_ID}`, label: "quotes" },
    { path: `/api/travel/invoices/${FAKE_ID}`, label: "invoices" },
    { path: `/api/travel/itineraries/${FAKE_ID}`, label: "itineraries" },
    { path: `/api/travel/flyer-templates/${FAKE_ID}`, label: "flyer-templates" },
    { path: `/api/travel/supplier-credentials/${FAKE_ID}`, label: "supplier-credentials" },
    // Slice 2 — extended sweep across 6 additional /:id endpoints.
    // Each lives behind requireTravelTenant per backend/routes/travel_*.js
    // (verified mounts in server.js:701..739). The 999999999 sentinel
    // proves the guard fires regardless of id existence — i.e. there is
    // no id-enumeration surface for cross-vertical attackers.
    { path: `/api/travel/trips/${FAKE_ID}`, label: "trips (TmcTrip)" },
    { path: `/api/travel/diagnostics/${FAKE_ID}`, label: "diagnostics" },
    { path: `/api/travel/diagnostic-banks/${FAKE_ID}`, label: "diagnostic-banks" },
    { path: `/api/travel/suppliers/${FAKE_ID}`, label: "suppliers" },
    { path: `/api/travel/cost-master/${FAKE_ID}`, label: "cost-master" },
    { path: `/api/travel/rfu-profiles/${FAKE_ID}`, label: "rfu-profiles" },
  ];

  for (const { path, label } of TRAVEL_ROUTES) {
    test(`wellness admin GET ${path} → 403 WRONG_VERTICAL (${label})`, async ({ request }) => {
      const token = await getWellnessAdmin(request);
      if (!token) test.skip(true, "wellness admin token required");
      const res = await get(request, token, path);
      expect(
        res.status(),
        `wellness admin must not reach ${path}: got ${res.status()} (${await res.text()})`,
      ).toBe(403);
      const body = await res.json();
      expect(body.code, `${path}: expected code=WRONG_VERTICAL`).toBe("WRONG_VERTICAL");
    });

    test(`generic admin GET ${path} → 403 WRONG_VERTICAL (${label})`, async ({ request }) => {
      const token = await getGenericAdmin(request);
      if (!token) test.skip(true, "generic admin token required");
      const res = await get(request, token, path);
      expect(
        res.status(),
        `generic admin must not reach ${path}: got ${res.status()} (${await res.text()})`,
      ).toBe(403);
      const body = await res.json();
      expect(body.code, `${path}: expected code=WRONG_VERTICAL`).toBe("WRONG_VERTICAL");
    });
  }

  test("travel admin GET on a NON-EXISTENT id → 404 (sanity — guard is not 403-forever)", async ({ request }) => {
    // This is the canary that proves the WRONG_VERTICAL responses above
    // are tenant-specific, not just "everyone gets 403". A travel-tenant
    // admin reaches the lookup and gets a normal 404 for the fake id.
    const token = await getTravelAdmin(request);
    if (!token) test.skip(true, "travel admin token required");
    const res = await get(request, token, `/api/travel/quotes/${FAKE_ID}`);
    expect(
      res.status(),
      `travel admin should reach lookup + get 404 on fake id: got ${res.status()} (${await res.text()})`,
    ).toBe(404);
  });

  // Slice 2 — layered-guard-order pin for /api/travel/trips/:id.
  // travel_trips.js:181 mounts BOTH requireTravelTenant AND
  // requireTmcAccess. The middleware chain order matters: vertical
  // guard MUST run FIRST so wellness/generic attackers can't even
  // discover whether sub-brand access is the blocker. A regression
  // that flipped the order would surface as 403 TMC_ACCESS_DENIED
  // (or similar) on the cross-vertical attacker — pinning
  // WRONG_VERTICAL specifically catches that.
  test("guard-order: cross-vertical attacker on /trips/:id hits WRONG_VERTICAL FIRST (not TMC_ACCESS)", async ({
    request,
  }) => {
    const wellness = await getWellnessAdmin(request);
    if (!wellness) test.skip(true, "wellness admin token required");
    const res = await get(request, wellness, `/api/travel/trips/${FAKE_ID}`);
    expect(res.status()).toBe(403);
    const body = await res.json();
    expect(
      body.code,
      `expected vertical-guard to fire first; got code=${body.code}`,
    ).toBe("WRONG_VERTICAL");
    // Explicitly NOT one of the sub-brand denial codes.
    expect(body.code).not.toBe("TMC_ACCESS_DENIED");
    expect(body.code).not.toBe("NO_TMC_ACCESS");
  });

  // Slice 2 — enumeration-prevention pin. Cross-vertical attackers
  // must get identical 403 shapes for id=1 (likely exists in some
  // tenant) and id=999999999 (almost certainly does not). If the
  // status differed between the two, the response would leak
  // id-existence across the vertical boundary — a side-channel IDOR.
  test("enumeration-prevention: cross-vertical 403 shape is identical for id=1 and id=999999999", async ({
    request,
  }) => {
    const wellness = await getWellnessAdmin(request);
    if (!wellness) test.skip(true, "wellness admin token required");
    const lowIdRes = await get(request, wellness, `/api/travel/diagnostics/1`);
    const highIdRes = await get(request, wellness, `/api/travel/diagnostics/${FAKE_ID}`);
    expect(lowIdRes.status(), "id=1 must 403 (not 404)").toBe(403);
    expect(highIdRes.status(), `id=${FAKE_ID} must 403 (not 404)`).toBe(403);
    const lowBody = await lowIdRes.json();
    const highBody = await highIdRes.json();
    expect(lowBody.code).toBe("WRONG_VERTICAL");
    expect(highBody.code).toBe("WRONG_VERTICAL");
  });
});

// ─── Auth gate ───────────────────────────────────────────────────────
// Defense-in-depth: probes without ANY token should never 200, regardless
// of vertical. The global auth guard 401/403s before requireTravelTenant.

test.describe("IDOR #919 — auth gate (no token never 200s)", () => {
  test("GET /api/contacts/1 without token → 401/403", async ({ request }) => {
    const res = await request.get(`${BASE_URL}/api/contacts/1`, {
      timeout: REQUEST_TIMEOUT,
    });
    expect([401, 403]).toContain(res.status());
  });

  test("GET /api/travel/quotes/1 without token → 401/403", async ({ request }) => {
    const res = await request.get(`${BASE_URL}/api/travel/quotes/1`, {
      timeout: REQUEST_TIMEOUT,
    });
    expect([401, 403]).toContain(res.status());
  });

  test("GET /api/travel/supplier-credentials/1 without token → 401/403", async ({ request }) => {
    const res = await request.get(`${BASE_URL}/api/travel/supplier-credentials/1`, {
      timeout: REQUEST_TIMEOUT,
    });
    expect([401, 403]).toContain(res.status());
  });

  // Slice 2 — auth-gate sweep extended to the new routes added above.
  // Generated parametrically because the contract is identical: no
  // token must never 200 on a /:id endpoint, regardless of vertical /
  // sub-brand / route. Parametric to keep the spec compact.
  const NO_TOKEN_ROUTES = [
    `/api/travel/trips/1`,
    `/api/travel/diagnostics/1`,
    `/api/travel/diagnostic-banks/1`,
    `/api/travel/suppliers/1`,
    `/api/travel/cost-master/1`,
    `/api/travel/rfu-profiles/1`,
  ];
  for (const path of NO_TOKEN_ROUTES) {
    test(`GET ${path} without token → 401/403`, async ({ request }) => {
      const res = await request.get(`${BASE_URL}${path}`, {
        timeout: REQUEST_TIMEOUT,
      });
      expect(
        [401, 403],
        `auth gate on ${path}: got ${res.status()} (${await res.text()})`,
      ).toContain(res.status());
    });
  }
});
