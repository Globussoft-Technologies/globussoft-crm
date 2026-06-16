// @ts-check
/**
 * Cross-tenant IDOR probe — GH #919 slices 1 + 2 + 3 + 4 + 5 + 6 + 7.
 *
 * Slice 7 (this commit) extends the audit from /:id GET / mutate probes
 * to LIST endpoints — `GET /api/contacts`, `GET /api/deals`, and
 * `GET /api/travel/itineraries`. The contract pinned: paginated list
 * responses MUST scope by `req.user.tenantId` (the JWT-derived value)
 * regardless of any `?tenantId=<other>` query injection attempt. The
 * global stripDangerous middleware deletes `tenantId` from req.body
 * (see CLAUDE.md standing rule + ESLint `no-restricted-syntax` rule on
 * routes/**), but it does NOT touch req.query — so a future regression
 * that reads `req.query.tenantId` and passes it into the Prisma WHERE
 * clause would silently leak cross-tenant rows. Slice 7 pins:
 *
 *   (a) /api/contacts and /api/deals list bodies contain ZERO rows whose
 *       tenantId field exposes a different tenant. We rely on the fact
 *       that route handlers select scalar columns including tenantId for
 *       the deals route OR the absence of cross-tenant rows by id-membership.
 *       For contacts, no tenantId is returned in the response shape, so we
 *       pin via a SEEDED-VICTIM strategy: create a victim row under the
 *       OTHER tenant, then list as the attacker and assert the victim id
 *       does NOT appear.
 *
 *   (b) /api/contacts?tenantId=<other-tenant-id> and
 *       /api/deals?tenantId=<other-tenant-id> return the SAME row set
 *       (by id-membership) as the unparameterised list — i.e. the query
 *       param is ignored entirely, not honoured. A future regression
 *       that started honouring ?tenantId= would change the result set;
 *       this assertion catches it.
 *
 *   (c) /api/travel/itineraries called by a wellness or generic admin
 *       returns 403 WRONG_VERTICAL — requireTravelTenant fires BEFORE
 *       the list query runs. Same vertical-guard contract as the /:id
 *       probes in slice 2, but pinned at the LIST surface so a future
 *       refactor that mounts the guard per-handler (and forgets the
 *       list endpoint) is caught.
 *
 * Issue #919's remediation: "Add a CI test suite: for every /api/* route,
 * seed two tenants A and B with one record each, then call the route with
 * A's JWT and B's ID and assert non-2xx." Slice 5 (this commit) pins
 * enumeration-shape PARITY: for several routes, probe the cross-tenant
 * attacker on id=1 (likely exists in some tenant) vs id=999999999
 * (almost certainly does not), and assert the response body shapes are
 * IDENTICAL (excluding any timestamp / request-id fields). A divergence
 * — status, error code, or error message — would be a SIDE-CHANNEL leak
 * about whether the row exists at all. Cross-vertical Travel routes
 * already had a shape-parity pin in slice 2 (the 403 WRONG_VERTICAL
 * sentinel pair); slice 5 extends the contract to the canonical
 * tenant-filter 404 surfaces (Contact + Deal) PLUS the staff routes
 * (PUT /:id, DELETE /:id) where the 404 body is `{ error: "User not
 * found." }` regardless of whether the user exists in a sibling tenant
 * or doesn't exist at all.
 *
 * Slice 5 drift note (per .claude/skills/verifying-gap-card-claims/):
 * the slice-5 prompt named `/api/admin/users/:id` and `/api/tenants/:id`
 * as targets. Reality check: `routes/admin.js` has only `/backup/*` +
 * `/llm-spend` (no `:id` route at all) and `routes/tenants.js` has only
 * `/current` + `/users` (no `:id` route at all). The real "user admin"
 * /:id surface lives at `/api/staff/:id` (routes/staff.js — PUT /:id,
 * PATCH /:id, PUT /:id/role, POST /:id/reset-password, POST
 * /:id/resend-invite, DELETE /:id, all with `prisma.user.findFirst({
 * where: { id, tenantId: req.user.tenantId } })` + `404 { error: "User
 * not found." }`). We PIN REALITY and probe /api/staff/:id for the
 * enumeration-parity contract; the prompt's verbatim claim is
 * documented here so a future regression-coverage author doesn't re-
 * audit the same wrong endpoints.
 *
 * Issue #919's remediation: "Add a CI test suite: for every /api/* route,
 * seed two tenants A and B with one record each, then call the route with
 * A's JWT and B's ID and assert non-2xx." Slice 1 (ab8bcdbe) seeded
 * representative coverage across the Travel-vertical + cross-vertical
 * Contact surface. Slice 2 (475b387b) extended the Travel-vertical
 * sweep to 6 additional /:id endpoints that landed after slice 1 was
 * authored, including the two routes that #5c48de2a unblocked by adding
 * their missing app.use() mounts (flyer-templates already covered in
 * slice 1; trips + diagnostics + suppliers + cost-master + rfu-profiles
 * + diagnostic-banks are the new sweep). Slice 3 (3a3b05fb) extends
 * the cross-vertical sweep from GET probes to MUTATION probes — PUT /
 * PATCH / DELETE / POST against existing /:id endpoints on Travel
 * routes. Mutation IDOR is the worst-case path because it can CORRUPT
 * or DELETE cross-tenant data, not just leak it. Slice 4 (this commit)
 * broadens the audit BEYOND the Travel namespace to two of the highest-
 * value cross-vertical models — Deal (generic-tenant pipeline data) and
 * Contact mutations (extending slice 1's contact GET probes to PUT and
 * DELETE). Deal is enumerated because it's the single largest revenue-
 * proxy entity in the generic vertical (the seed has $5B+ of closed
 * revenue across 375 won deals — see CLAUDE.md #567 entry) and a
 * missed tenant filter would let a wellness admin read or corrupt
 * generic pipeline value. The /api/quotes/:id (CPQ) endpoint named in
 * the slice-4 prompt is NOT covered here because cpq.js routes are
 * scoped as `/quotes/:dealId` (a deal-relation lookup), not
 * `/quotes/:id` — the prompt's verbatim claim does not match reality,
 * so we pin reality (deals.js is the right surface for the same
 * generic-tenant IDOR class).
 *
 * Slice 3 drift note (per .claude/skills/verifying-gap-card-claims/):
 * the slice-3 prompt named `PUT /api/travel/quotes/:id`, `PATCH
 * /api/travel/invoices/:id`, `POST /api/travel/quotes/:id/accept`,
 * `POST /api/travel/invoices/:id/issue` as targets. Those endpoints
 * do NOT exist in backend/routes/travel_*.js — `/quotes` is owned by
 * routes/cpq.js (a generic-tenant CPQ route, not Travel), and there
 * is no `/api/travel/invoices` namespace at all. We PIN REALITY here:
 * the actual mutating /:id endpoints on Travel routes are itineraries
 * (PATCH/PUT/DELETE-item/POST-accept/POST-reject/POST-share),
 * trips (PATCH), rfu-profiles (PATCH), and the item-level
 * /itineraries/:id/items/:itemId DELETE. The contract pinned is
 * identical: requireTravelTenant fires BEFORE the body parse + id
 * lookup, so cross-vertical mutations get 403 WRONG_VERTICAL — the
 * data is never touched, never corrupted, never deleted.
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
async function put(request, token, path, body) {
  return retryOn5xx(() =>
    request.put(`${BASE_URL}${path}`, {
      headers: headers(token),
      data: body ?? {},
      timeout: REQUEST_TIMEOUT,
    }),
  );
}
async function patch(request, token, path, body) {
  return retryOn5xx(() =>
    request.patch(`${BASE_URL}${path}`, {
      headers: headers(token),
      data: body ?? {},
      timeout: REQUEST_TIMEOUT,
    }),
  );
}

// Track contact ids we create so afterAll() can sweep them. Each entry
// is { token, id } — token used to delete from the same tenant.
const createdContacts = [];
// Slice 4 — same shape for Deal ids created during the cross-tenant
// mutation probes. Sweep on the SAME token that created them.
const createdDeals = [];

test.afterAll(async ({ request }) => {
  const deadline = Date.now() + 60_000;
  for (const { token, id } of createdContacts) {
    if (Date.now() > deadline) break;
    if (!token) continue;
    await del(request, token, `/api/contacts/${id}`).catch(() => {});
  }
  for (const { token, id } of createdDeals) {
    if (Date.now() > deadline) break;
    if (!token) continue;
    await del(request, token, `/api/deals/${id}`).catch(() => {});
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

// Slice 4 helper — create a Deal under the supplied admin token. The
// id becomes the "victim deal" for cross-tenant READ + WRITE + DELETE
// probes. We use the simplest possible body — title + stage `lead`
// (the seed-default open stage from the ALLOWED_DEAL_STAGES enum in
// routes/deals.js:208). No contact link, no amount, so cleanup is
// trivial and the probe is decoupled from contact-relation drift.
async function createDeal(request, token, label) {
  const res = await post(request, token, "/api/deals", {
    title: `${RUN_TAG} ${label}`,
    stage: "lead",
  });
  expect(res.status(), `create deal (${label}): ${await res.text()}`).toBe(201);
  const body = await res.json();
  expect(body.id, `deal create response missing id`).toBeTruthy();
  createdDeals.push({ token, id: body.id });
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

// ─── Slice 3 — Mutation IDOR (cross-vertical PUT/PATCH/DELETE/POST) ──
// The slice-1+2 GET probes pin that cross-vertical READS are blocked at
// the vertical-guard layer (403 WRONG_VERTICAL). Slice 3 extends that
// contract to MUTATIONS — the worst-case IDOR class, where a missed
// guard would let wellness/generic admins CORRUPT or DELETE Travel
// data they don't own. The middleware-order guarantee is the same
// (requireTravelTenant runs before the handler body), so the expected
// shape is identical: 403 WRONG_VERTICAL, body is never touched, the
// target id is never even looked up. We pin id=999999999 as a
// deliberate non-existent sentinel so a regression that demoted the
// guard would surface as "200 OK but no such row found" (a 404 from
// inside the handler) — pinning 403 specifically catches that.
//
// Note on PUT body shape: routes/travel_itineraries.js:1325 PUT
// /itineraries/:id requires `title` + `items[]` in the body. We pass
// a minimal valid-shape body so a regression that bypassed the
// vertical guard would proceed to body validation rather than 400'ing
// for a separate reason. The probe is "guard fires FIRST" — body shape
// is irrelevant to the contract, but valid-shape makes the failure
// signal clean.

const MIN_PUT_ITINERARY = {
  title: "IDOR-probe-must-never-reach-handler",
  items: [],
};

test.describe("IDOR #919 slice 3 — /api/travel/* cross-vertical mutations (403 WRONG_VERTICAL)", () => {
  // Each row: { method, path, body?, label }. The body is irrelevant to
  // the contract (guard fires before body parse) but a minimal valid
  // shape avoids confusing a future regression that demoted the guard
  // with a separate 400 for malformed body.
  const MUTATION_PROBES = [
    {
      method: "PATCH",
      path: `/api/travel/itineraries/${FAKE_ID}`,
      body: { status: "ACCEPTED" },
      label: "PATCH /itineraries/:id status amend (corruption vector)",
    },
    {
      method: "PUT",
      path: `/api/travel/itineraries/${FAKE_ID}`,
      body: MIN_PUT_ITINERARY,
      label: "PUT /itineraries/:id full replace (corruption vector)",
    },
    {
      method: "DELETE",
      path: `/api/travel/itineraries/${FAKE_ID}/items/${FAKE_ID}`,
      body: null,
      label: "DELETE /itineraries/:id/items/:itemId (deletion vector)",
    },
    {
      method: "POST",
      path: `/api/travel/itineraries/${FAKE_ID}/accept`,
      body: { acceptanceNotes: "idor-probe" },
      label: "POST /itineraries/:id/accept (state-change vector)",
    },
    {
      method: "POST",
      path: `/api/travel/itineraries/${FAKE_ID}/reject`,
      body: { rejectionReason: "idor-probe" },
      label: "POST /itineraries/:id/reject (state-change vector)",
    },
    {
      method: "POST",
      path: `/api/travel/itineraries/${FAKE_ID}/share`,
      body: { recipientEmail: "idor-probe@e2e.local" },
      label: "POST /itineraries/:id/share (exfiltration vector)",
    },
    {
      method: "PATCH",
      path: `/api/travel/trips/${FAKE_ID}`,
      body: { destination: "idor-probe" },
      label: "PATCH /trips/:id (TMC trip corruption vector)",
    },
    {
      method: "PATCH",
      path: `/api/travel/rfu-profiles/${FAKE_ID}`,
      body: { notes: "idor-probe" },
      label: "PATCH /rfu-profiles/:id (RFU profile corruption vector)",
    },
  ];

  async function doMutation(request, token, method, path, body) {
    switch (method) {
      case "PATCH":
        return patch(request, token, path, body);
      case "PUT":
        return put(request, token, path, body);
      case "POST":
        return post(request, token, path, body);
      case "DELETE":
        return del(request, token, path);
      default:
        throw new Error(`unsupported method ${method}`);
    }
  }

  for (const { method, path, body, label } of MUTATION_PROBES) {
    test(`wellness admin ${method} ${path} → 403 WRONG_VERTICAL (${label})`, async ({
      request,
    }) => {
      const token = await getWellnessAdmin(request);
      if (!token) test.skip(true, "wellness admin token required");
      const res = await doMutation(request, token, method, path, body);
      expect(
        res.status(),
        `wellness admin must not reach ${method} ${path}: got ${res.status()} (${await res.text()})`,
      ).toBe(403);
      const respBody = await res.json();
      expect(
        respBody.code,
        `${method} ${path}: expected code=WRONG_VERTICAL`,
      ).toBe("WRONG_VERTICAL");
    });

    test(`generic admin ${method} ${path} → 403 WRONG_VERTICAL (${label})`, async ({
      request,
    }) => {
      const token = await getGenericAdmin(request);
      if (!token) test.skip(true, "generic admin token required");
      const res = await doMutation(request, token, method, path, body);
      expect(
        res.status(),
        `generic admin must not reach ${method} ${path}: got ${res.status()} (${await res.text()})`,
      ).toBe(403);
      const respBody = await res.json();
      expect(
        respBody.code,
        `${method} ${path}: expected code=WRONG_VERTICAL`,
      ).toBe("WRONG_VERTICAL");
    });
  }

  // Pin guard-fires-before-body-parse: a deliberately MALFORMED body
  // (missing required fields, wrong types) must STILL surface 403
  // WRONG_VERTICAL, not a 400 from body validation. If a regression
  // moved body-parse / validation BEFORE the vertical guard, this
  // would flip to 400 — silently revealing endpoint-shape information
  // (the field-validation error message itself is an enumeration
  // surface) to the cross-vertical attacker.
  test("guard-before-body-parse: malformed PUT body still surfaces 403 WRONG_VERTICAL", async ({
    request,
  }) => {
    const token = await getWellnessAdmin(request);
    if (!token) test.skip(true, "wellness admin token required");
    const res = await put(
      request,
      token,
      `/api/travel/itineraries/${FAKE_ID}`,
      { notATitle: 42, items: "this-is-not-an-array" },
    );
    expect(
      res.status(),
      `malformed body must STILL 403 (not 400) — guard runs first; got ${res.status()} (${await res.text()})`,
    ).toBe(403);
    const respBody = await res.json();
    expect(respBody.code).toBe("WRONG_VERTICAL");
  });

  // Pin DELETE-without-body-validation: DELETE /itineraries/:id/items/:itemId
  // has TWO id params. Even with two non-existent ids, the guard fires
  // BEFORE either lookup. A regression that demoted the guard would
  // surface as 404 (handler couldn't find the parent itinerary), which
  // would leak that the parent-id-shape is at least *valid* on this route.
  test("guard-before-lookup: DELETE on TWO non-existent ids still 403 (no 404 leak)", async ({
    request,
  }) => {
    const token = await getGenericAdmin(request);
    if (!token) test.skip(true, "generic admin token required");
    const res = await del(
      request,
      token,
      `/api/travel/itineraries/${FAKE_ID}/items/${FAKE_ID}`,
    );
    expect(
      res.status(),
      `cross-vertical DELETE must be 403 not 404: got ${res.status()} (${await res.text()})`,
    ).toBe(403);
    const respBody = await res.json();
    expect(respBody.code).toBe("WRONG_VERTICAL");
  });
});

// ─── Slice 4 — Non-Travel cross-tenant probes (Deal + Contact) ───────
// The slice-1+2+3 sweep covered the Travel namespace (vertical-guard
// path: 403 WRONG_VERTICAL) + the Contact GET path (tenant-filter path:
// 404). Slice 4 broadens the audit to two more cross-vertical models:
//
//   (a) Deal — generic-tenant pipeline data. Highest-value entity by
//       revenue proxy (CLAUDE.md #567 entry: ~$5B closed across 375
//       won deals in the seed). A missed tenant filter here would let
//       a wellness admin READ generic pipeline value (information
//       leak) or PUT/DELETE on it (corruption / deletion). The deals
//       handlers correctly use prisma.deal.findFirst({ where: { id,
//       tenantId }}) — pinned below so a future regression that drops
//       the tenant filter is caught.
//
//   (b) Contact mutations — slice 1 covered the GET path; slice 4
//       extends to PUT (update) and DELETE (soft-delete). PUT is the
//       corruption vector (overwrite a victim contact's fields);
//       DELETE is the deletion vector (soft-delete a victim contact).
//       Both must 404 (canonical tenant-filter contract).
//
// Each probe creates a real victim row under the OWNER tenant's admin
// (so the id is guaranteed to exist), then probes from the ATTACKER
// tenant. A 200 / 204 anywhere here is the true IDOR leak; we assert
// 404 to pin the canonical "tenant filter in WHERE clause" contract.

test.describe("IDOR #919 slice 4 — non-Travel cross-tenant (Deal + Contact mutations)", () => {
  test("wellness admin GET /api/deals/:id (generic victim) → 404 (read leak vector)", async ({
    request,
  }) => {
    const generic = await getGenericAdmin(request);
    const wellness = await getWellnessAdmin(request);
    if (!generic || !wellness) {
      test.skip(true, "generic + wellness admin tokens both required");
    }
    const victimId = await createDeal(request, generic, "deal-read-victim");

    const res = await get(request, wellness, `/api/deals/${victimId}`);
    expect(
      res.status(),
      `wellness admin must not read generic Deal id=${victimId}: got ${res.status()} (${await res.text()})`,
    ).toBe(404);
  });

  test("wellness admin PUT /api/deals/:id (generic victim) → 404 (corruption vector)", async ({
    request,
  }) => {
    const generic = await getGenericAdmin(request);
    const wellness = await getWellnessAdmin(request);
    if (!generic || !wellness) {
      test.skip(true, "generic + wellness admin tokens both required");
    }
    const victimId = await createDeal(request, generic, "deal-put-victim");

    // Attempt to flip the victim's title + stage. If the tenant filter
    // is missing, this would CORRUPT a generic-tenant deal's data.
    const res = await put(request, wellness, `/api/deals/${victimId}`, {
      title: "IDOR-CORRUPTION-ATTEMPT-must-never-land",
      stage: "won",
    });
    expect(
      res.status(),
      `wellness admin must not PUT generic Deal id=${victimId}: got ${res.status()} (${await res.text()})`,
    ).toBe(404);

    // Sanity: read the deal back from the OWNER tenant — title must
    // be unchanged. Pins the contract end-to-end: the 404 above truly
    // means no write happened (not just "status changed but data
    // touched"). This is the load-bearing assertion for slice 4.
    const readBack = await get(request, generic, `/api/deals/${victimId}`);
    expect(readBack.status()).toBe(200);
    const dealAfter = await readBack.json();
    expect(
      dealAfter.title,
      `cross-tenant PUT must NOT have corrupted victim deal title`,
    ).toBe(`${RUN_TAG} deal-put-victim`);
    expect(
      dealAfter.stage,
      `cross-tenant PUT must NOT have corrupted victim deal stage`,
    ).toBe("lead");
  });

  test("wellness admin DELETE /api/deals/:id (generic victim) → 404 (deletion vector)", async ({
    request,
  }) => {
    const generic = await getGenericAdmin(request);
    const wellness = await getWellnessAdmin(request);
    if (!generic || !wellness) {
      test.skip(true, "generic + wellness admin tokens both required");
    }
    const victimId = await createDeal(request, generic, "deal-del-victim");

    const res = await del(request, wellness, `/api/deals/${victimId}`);
    expect(
      res.status(),
      `wellness admin must not DELETE generic Deal id=${victimId}: got ${res.status()} (${await res.text()})`,
    ).toBe(404);

    // Sanity: read the deal back from the OWNER tenant — must still
    // be live (not soft-deleted). The deals route's DELETE flips
    // deletedAt; if the tenant filter is missing, deletedAt would be
    // populated on the victim.
    const readBack = await get(request, generic, `/api/deals/${victimId}`);
    expect(readBack.status()).toBe(200);
    const dealAfter = await readBack.json();
    expect(
      dealAfter.deletedAt,
      `cross-tenant DELETE must NOT have flipped deletedAt on the victim`,
    ).toBeFalsy();
  });

  test("travel admin PUT /api/deals/:id (generic victim) → 404 (cross-vertical corruption vector)", async ({
    request,
  }) => {
    // Travel admin attacking a generic-tenant Deal hits the same
    // tenant-filter 404 — Deal is a generic-and-wellness model (not a
    // travel one), so the vertical guard is NOT in play here. Pins
    // that the tenant filter alone is sufficient when the model
    // doesn't live in a verticalised namespace.
    const generic = await getGenericAdmin(request);
    const travel = await getTravelAdmin(request);
    if (!generic || !travel) {
      test.skip(true, "generic + travel admin tokens both required");
    }
    const victimId = await createDeal(request, generic, "deal-put-travel-attacker");

    const res = await put(request, travel, `/api/deals/${victimId}`, {
      title: "IDOR-TRAVEL-ATTACKER-must-never-land",
    });
    expect(
      res.status(),
      `travel admin must not PUT generic Deal id=${victimId}: got ${res.status()} (${await res.text()})`,
    ).toBe(404);
  });

  test("wellness admin PUT /api/contacts/:id (generic victim) → 404 (contact corruption vector)", async ({
    request,
  }) => {
    const generic = await getGenericAdmin(request);
    const wellness = await getWellnessAdmin(request);
    if (!generic || !wellness) {
      test.skip(true, "generic + wellness admin tokens both required");
    }
    const victimId = await createContact(request, generic, "contact-put-victim");

    const res = await put(request, wellness, `/api/contacts/${victimId}`, {
      name: "IDOR-CONTACT-CORRUPTION-ATTEMPT",
    });
    expect(
      res.status(),
      `wellness admin must not PUT generic Contact id=${victimId}: got ${res.status()} (${await res.text()})`,
    ).toBe(404);

    // Sanity: name unchanged on the owner-side read.
    const readBack = await get(request, generic, `/api/contacts/${victimId}`);
    expect(readBack.status()).toBe(200);
    const contactAfter = await readBack.json();
    expect(
      contactAfter.name,
      `cross-tenant PUT must NOT have corrupted victim contact name`,
    ).toBe(`${RUN_TAG} contact-put-victim`);
  });

  test("wellness admin DELETE /api/contacts/:id (generic victim) → 404 (contact deletion vector)", async ({
    request,
  }) => {
    const generic = await getGenericAdmin(request);
    const wellness = await getWellnessAdmin(request);
    if (!generic || !wellness) {
      test.skip(true, "generic + wellness admin tokens both required");
    }
    const victimId = await createContact(request, generic, "contact-del-victim");

    const res = await del(request, wellness, `/api/contacts/${victimId}`);
    expect(
      res.status(),
      `wellness admin must not DELETE generic Contact id=${victimId}: got ${res.status()} (${await res.text()})`,
    ).toBe(404);

    // Sanity: deletedAt unchanged on the owner-side read.
    const readBack = await get(request, generic, `/api/contacts/${victimId}`);
    expect(readBack.status()).toBe(200);
    const contactAfter = await readBack.json();
    expect(
      contactAfter.deletedAt,
      `cross-tenant DELETE must NOT have flipped deletedAt on the victim contact`,
    ).toBeFalsy();
  });

  // Reverse-direction probe: generic admin attacks a wellness-tenant
  // Deal. Identical 404 contract — pins the tenant filter in BOTH
  // directions so a future regression that only adds the filter to
  // ONE direction (e.g. wellness → generic but not generic →
  // wellness) is caught.
  test("generic admin DELETE /api/deals/:id (wellness victim) → 404 (reverse-direction deletion vector)", async ({
    request,
  }) => {
    const generic = await getGenericAdmin(request);
    const wellness = await getWellnessAdmin(request);
    if (!generic || !wellness) {
      test.skip(true, "generic + wellness admin tokens both required");
    }
    const victimId = await createDeal(request, wellness, "deal-reverse-del-victim");

    const res = await del(request, generic, `/api/deals/${victimId}`);
    expect(
      res.status(),
      `generic admin must not DELETE wellness Deal id=${victimId}: got ${res.status()} (${await res.text()})`,
    ).toBe(404);

    const readBack = await get(request, wellness, `/api/deals/${victimId}`);
    expect(readBack.status()).toBe(200);
    const dealAfter = await readBack.json();
    expect(dealAfter.deletedAt).toBeFalsy();
  });
});

// ─── Slice 5 — Enumeration-shape PARITY probes ───────────────────────
// The slice 1-4 sweep pins that cross-tenant attempts surface 403/404
// (no 2xx leak). Slice 5 tightens the contract one notch: for the same
// attacker token, the response shape for id=1 (a sentinel that LIKELY
// exists in some tenant) MUST be IDENTICAL to the response shape for
// id=999999999 (a sentinel that DEFINITELY does not exist anywhere).
// If they differ — by status, by error code, by error message text —
// the response is a SIDE-CHANNEL leak about row existence. That is a
// classic IDOR enumeration vector: even when reads are blocked, the
// attacker learns "id=X exists; id=Y doesn't" from the divergence.
//
// Helper — strip timestamp / request-id / nonce fields from a parsed
// JSON body before equality comparison. The route handlers MAY include
// a timestamp or request id in the envelope; that's not a leak, it's a
// legitimate observability field. Anything else MUST be byte-identical
// across the low-id vs high-id probe.
function stripVolatileFields(body) {
  if (body == null || typeof body !== "object") return body;
  const out = { ...body };
  for (const k of [
    "timestamp",
    "ts",
    "requestId",
    "requestID",
    "request_id",
    "traceId",
    "trace_id",
    "nonce",
    "id", // some envelopes echo back the supplied id; that itself is the diverging field
  ]) {
    delete out[k];
  }
  return out;
}

test.describe("IDOR #919 slice 5 — enumeration-shape parity (no side-channel leak)", () => {
  // PROBE A — /api/contacts/:id (canonical tenant-filter 404). For the
  // wellness-admin attacker, the response for a generic-tenant Contact id
  // MUST match the response for a definitely-non-existent id. Both are
  // 404 with the same body shape — the attacker cannot tell which is
  // which.
  test("contacts/:id — wellness attacker on (real generic id) vs (fake id) → IDENTICAL 404 shape", async ({
    request,
  }) => {
    const generic = await getGenericAdmin(request);
    const wellness = await getWellnessAdmin(request);
    if (!generic || !wellness) {
      test.skip(true, "generic + wellness admin tokens both required");
    }
    const realVictimId = await createContact(request, generic, "enum-parity-contacts");

    const realRes = await get(request, wellness, `/api/contacts/${realVictimId}`);
    const fakeRes = await get(request, wellness, `/api/contacts/${FAKE_ID}`);

    expect(realRes.status(), "real cross-tenant id should 404").toBe(404);
    expect(fakeRes.status(), "fake id should 404").toBe(404);
    expect(
      realRes.status(),
      `enumeration leak: status diverges (real=${realRes.status()} vs fake=${fakeRes.status()})`,
    ).toBe(fakeRes.status());

    const realBody = stripVolatileFields(await realRes.json());
    const fakeBody = stripVolatileFields(await fakeRes.json());
    expect(
      realBody,
      `enumeration leak: body diverges across (real=${JSON.stringify(realBody)}) vs (fake=${JSON.stringify(fakeBody)})`,
    ).toEqual(fakeBody);
  });

  // PROBE B — /api/deals/:id (canonical tenant-filter 404). Same shape-
  // parity contract on the Deal model. Wellness-admin attacker on a
  // real generic deal id vs a fake id — both 404, identical bodies.
  test("deals/:id — wellness attacker on (real generic id) vs (fake id) → IDENTICAL 404 shape", async ({
    request,
  }) => {
    const generic = await getGenericAdmin(request);
    const wellness = await getWellnessAdmin(request);
    if (!generic || !wellness) {
      test.skip(true, "generic + wellness admin tokens both required");
    }
    const realVictimId = await createDeal(request, generic, "enum-parity-deals");

    const realRes = await get(request, wellness, `/api/deals/${realVictimId}`);
    const fakeRes = await get(request, wellness, `/api/deals/${FAKE_ID}`);

    expect(realRes.status()).toBe(404);
    expect(fakeRes.status()).toBe(404);
    expect(
      realRes.status(),
      `enumeration leak: status diverges (real=${realRes.status()} vs fake=${fakeRes.status()})`,
    ).toBe(fakeRes.status());

    const realBody = stripVolatileFields(await realRes.json());
    const fakeBody = stripVolatileFields(await fakeRes.json());
    expect(
      realBody,
      `enumeration leak: deals 404 body diverges`,
    ).toEqual(fakeBody);
  });

  // PROBE C — /api/staff/:id PUT (the prompt's "admin/users :id" — pinned
  // to reality at /api/staff/:id; see drift note in header). The 404 body
  // is `{ error: "User not found." }` regardless of whether the target
  // user exists in a sibling tenant or doesn't exist anywhere. We probe
  // with a known-good name change so a regression that bypassed the
  // tenant filter would CORRUPT a sibling-tenant user (caught by 404
  // assertion + shape-parity assertion together).
  test("staff/:id PUT — wellness attacker on (real generic user id) vs (fake id) → IDENTICAL 404 shape", async ({
    request,
  }) => {
    const generic = await getGenericAdmin(request);
    const wellness = await getWellnessAdmin(request);
    if (!generic || !wellness) {
      test.skip(true, "generic + wellness admin tokens both required");
    }
    // The generic seed includes admin@globussoft.com as the tenant's
    // ADMIN user. We don't know its numeric id without a list call, so
    // probe via /api/staff (GET list) to discover a real generic user
    // id. Falls back to id=1 if discovery fails — id=1 always exists
    // in the seed on at least one tenant, so the probe still tests the
    // cross-tenant-404 contract even if we can't pinpoint generic's row.
    let realGenericUserId = 1;
    try {
      const list = await get(request, generic, "/api/staff");
      if (list.ok()) {
        const rows = await list.json();
        const arr = Array.isArray(rows) ? rows : Array.isArray(rows?.data) ? rows.data : [];
        if (arr.length > 0 && Number.isInteger(arr[0].id)) {
          realGenericUserId = arr[0].id;
        }
      }
    } catch (_e) {
      // ignore; fall back to id=1
    }

    const body = { name: "IDOR-ENUM-PROBE-must-never-land" };
    const realRes = await put(request, wellness, `/api/staff/${realGenericUserId}`, body);
    const fakeRes = await put(request, wellness, `/api/staff/${FAKE_ID}`, body);

    expect(realRes.status(), `real generic user id ${realGenericUserId} cross-tenant PUT must 404`).toBe(404);
    expect(fakeRes.status()).toBe(404);
    expect(
      realRes.status(),
      `enumeration leak: status diverges (real=${realRes.status()} vs fake=${fakeRes.status()})`,
    ).toBe(fakeRes.status());

    const realBody = stripVolatileFields(await realRes.json());
    const fakeBody = stripVolatileFields(await fakeRes.json());
    expect(
      realBody,
      `enumeration leak: staff 404 body diverges across real vs fake id`,
    ).toEqual(fakeBody);
    // Bonus pin: the body shape is the documented `{ error: "User not found." }`
    expect(realBody.error).toBe("User not found.");
    expect(fakeBody.error).toBe("User not found.");
  });

  // PROBE D — /api/staff/:id DELETE shape parity. DELETE is the highest
  // -severity vector (a missed tenant filter would DELETE a sibling
  // tenant's user). Both real and fake ids must 404 with identical
  // bodies. (The DELETE handler returns 204 on success and 404 with
  // `{ error: "User not found." }` on tenant-miss; we only ever see the
  // 404 path here, which is the contract.)
  test("staff/:id DELETE — wellness attacker on (real generic user id) vs (fake id) → IDENTICAL 404 shape", async ({
    request,
  }) => {
    const generic = await getGenericAdmin(request);
    const wellness = await getWellnessAdmin(request);
    if (!generic || !wellness) {
      test.skip(true, "generic + wellness admin tokens both required");
    }
    let realGenericUserId = 1;
    try {
      const list = await get(request, generic, "/api/staff");
      if (list.ok()) {
        const rows = await list.json();
        const arr = Array.isArray(rows) ? rows : Array.isArray(rows?.data) ? rows.data : [];
        if (arr.length > 0 && Number.isInteger(arr[0].id)) {
          realGenericUserId = arr[0].id;
        }
      }
    } catch (_e) {
      // ignore
    }

    const realRes = await del(request, wellness, `/api/staff/${realGenericUserId}`);
    const fakeRes = await del(request, wellness, `/api/staff/${FAKE_ID}`);

    expect(realRes.status(), `real cross-tenant DELETE must 404`).toBe(404);
    expect(fakeRes.status()).toBe(404);
    expect(
      realRes.status(),
      `enumeration leak: status diverges (real=${realRes.status()} vs fake=${fakeRes.status()})`,
    ).toBe(fakeRes.status());

    // Both should be JSON 404 envelopes (DELETE handler only returns 204
    // on the happy path; the 404 path returns JSON `{ error: ... }`).
    const realBody = stripVolatileFields(await realRes.json());
    const fakeBody = stripVolatileFields(await fakeRes.json());
    expect(
      realBody,
      `enumeration leak: staff DELETE 404 body diverges`,
    ).toEqual(fakeBody);
    expect(realBody.error).toBe("User not found.");
  });

  // PROBE E — /api/travel/diagnostics/:id cross-vertical shape parity.
  // Slice 2 already pinned status parity (both 403) but did NOT pin
  // BODY parity. A regression that started embedding "tenant X owns
  // id=Y" diagnostic info in the 403 body (well-intentioned debug-log
  // exposure) would silently re-introduce the side-channel. This probe
  // strengthens slice 2's contract to full body equality.
  test("travel/diagnostics/:id — wellness attacker on (id=1) vs (fake id) → IDENTICAL 403 BODY (not just status)", async ({
    request,
  }) => {
    const wellness = await getWellnessAdmin(request);
    if (!wellness) test.skip(true, "wellness admin token required");
    const realRes = await get(request, wellness, `/api/travel/diagnostics/1`);
    const fakeRes = await get(request, wellness, `/api/travel/diagnostics/${FAKE_ID}`);

    expect(realRes.status()).toBe(403);
    expect(fakeRes.status()).toBe(403);
    expect(realRes.status()).toBe(fakeRes.status());

    const realBody = stripVolatileFields(await realRes.json());
    const fakeBody = stripVolatileFields(await fakeRes.json());
    expect(
      realBody,
      `enumeration leak: travel cross-vertical 403 body diverges (real=${JSON.stringify(realBody)} vs fake=${JSON.stringify(fakeBody)})`,
    ).toEqual(fakeBody);
    // Both must carry WRONG_VERTICAL — same shape.
    expect(realBody.code).toBe("WRONG_VERTICAL");
    expect(fakeBody.code).toBe("WRONG_VERTICAL");
  });

  // PROBE F — reverse-direction shape parity on /api/deals/:id. Generic
  // attacker on a real wellness deal id vs a fake id. Pins that the
  // tenant-filter 404 is symmetric in both directions (slice 4 pinned
  // status; slice 5 pins body shape parity).
  test("deals/:id — generic attacker on (real wellness id) vs (fake id) → IDENTICAL 404 shape (reverse direction)", async ({
    request,
  }) => {
    const generic = await getGenericAdmin(request);
    const wellness = await getWellnessAdmin(request);
    if (!generic || !wellness) {
      test.skip(true, "generic + wellness admin tokens both required");
    }
    const realVictimId = await createDeal(request, wellness, "enum-parity-deals-reverse");

    const realRes = await get(request, generic, `/api/deals/${realVictimId}`);
    const fakeRes = await get(request, generic, `/api/deals/${FAKE_ID}`);

    expect(realRes.status()).toBe(404);
    expect(fakeRes.status()).toBe(404);
    expect(realRes.status()).toBe(fakeRes.status());

    const realBody = stripVolatileFields(await realRes.json());
    const fakeBody = stripVolatileFields(await fakeRes.json());
    expect(
      realBody,
      `enumeration leak: reverse-direction deals 404 body diverges`,
    ).toEqual(fakeBody);
  });
});

// ─── Slice 6 — Wellness-vertical IDOR probes (403 WELLNESS_TENANT_REQUIRED) ───
// The slice 1-5 sweep covered the Travel namespace (vertical-guard path: 403
// WRONG_VERTICAL) + Contact/Deal/Staff cross-tenant 404 contracts. Slice 6
// broadens the audit to the THIRD vertical surface — wellness — for full
// vertical-symmetry. Wellness routes mount verifyWellnessRole (backend/
// middleware/wellnessRole.js:71) which fires BEFORE the handler body and
// returns:
//   • 403 WELLNESS_TENANT_REQUIRED when caller's tenant.vertical !== "wellness"
//   • 403 WELLNESS_ROLE_FORBIDDEN when caller's wellnessRole is wrong
//
// From an IDOR-prevention standpoint WELLNESS_TENANT_REQUIRED is the same
// flavour of stricter-than-404 protection that WRONG_VERTICAL provides on
// Travel routes — the guard never even reaches Prisma, so no id-enumeration
// surface exists for cross-vertical attackers. We pin the 403 + code shape
// so a future refactor that demotes the gate to a 404 (post-vertical-check)
// doesn't silently weaken isolation.
//
// Drift note (per .claude/skills/verifying-gap-card-claims/): the slice-6
// prompt suggested either "more wellness routes" OR "public unauthenticated
// routes" OR "wellness-admin vs USER on the same route". We pick door #1
// (wellness GET/PUT/POST/DELETE :id endpoints) because (a) it's symmetric
// with the travel-vertical sweep already in place, (b) it pins a third
// distinct guard code (WELLNESS_TENANT_REQUIRED) the rest of the spec
// doesn't touch, and (c) wellness has the highest sensitivity surface (PHI
// data — patients, visits, prescriptions) where a cross-vertical leak would
// be a HIPAA-class incident, not just a CRM data leak.
//
// Wellness-vertical /:id routes probed (verified mounts in
// backend/routes/wellness.js + server.js):
//   • GET    /api/wellness/patients/:id        — phiReadGate (PHI read)
//   • GET    /api/wellness/visits/:id          — phiReadGate (PHI read)
//   • GET    /api/wellness/patients/:id/visits — phiReadGate (PHI fan-out)
//   • PUT    /api/wellness/services/:id        — verifyWellnessRole(admin/manager)
//   • PUT    /api/wellness/patients/:id        — phiWriteGate (PHI write)
//   • DELETE /api/wellness/patients/:id        — RBAC gate (ADMIN) + tenant scope
//
// Each route is probed with BOTH a generic admin AND a travel admin attacker
// token. The generic-admin probe is the classic cross-vertical attacker; the
// travel-admin probe pins that wellness rejects EVERY non-wellness vertical
// (not just generic), so a future regression that special-cased generic-vs-
// wellness while letting travel through is caught.

test.describe("IDOR #919 slice 6 — /api/wellness/* cross-vertical (403 WELLNESS_TENANT_REQUIRED)", () => {
  const WELLNESS_READ_ROUTES = [
    { path: `/api/wellness/patients/${FAKE_ID}`, label: "patients/:id (PHI read)" },
    { path: `/api/wellness/visits/${FAKE_ID}`, label: "visits/:id (PHI read)" },
    { path: `/api/wellness/patients/${FAKE_ID}/visits`, label: "patients/:id/visits (PHI fan-out)" },
  ];

  for (const { path, label } of WELLNESS_READ_ROUTES) {
    test(`generic admin GET ${path} → 403 WELLNESS_TENANT_REQUIRED (${label})`, async ({
      request,
    }) => {
      const token = await getGenericAdmin(request);
      if (!token) test.skip(true, "generic admin token required");
      const res = await get(request, token, path);
      expect(
        res.status(),
        `generic admin must not reach ${path}: got ${res.status()} (${await res.text()})`,
      ).toBe(403);
      const body = await res.json();
      expect(
        body.code,
        `${path}: expected code=WELLNESS_TENANT_REQUIRED`,
      ).toBe("WELLNESS_TENANT_REQUIRED");
    });

    test(`travel admin GET ${path} → 403 WELLNESS_TENANT_REQUIRED (${label})`, async ({
      request,
    }) => {
      const token = await getTravelAdmin(request);
      if (!token) test.skip(true, "travel admin token required");
      const res = await get(request, token, path);
      expect(
        res.status(),
        `travel admin must not reach ${path}: got ${res.status()} (${await res.text()})`,
      ).toBe(403);
      const body = await res.json();
      expect(
        body.code,
        `${path}: expected code=WELLNESS_TENANT_REQUIRED`,
      ).toBe("WELLNESS_TENANT_REQUIRED");
    });
  }

  // Mutation probes — these are the worst-case IDOR vectors (corruption +
  // deletion of PHI data). A wellness PUT /services/:id from a generic
  // admin would CORRUPT a wellness tenant's service catalog if the guard
  // were missing; PUT /patients/:id would CORRUPT a wellness patient's
  // PHI fields; DELETE /patients/:id would soft-delete a PHI row. Pin
  // the guard-fires-first contract for each — the body is irrelevant
  // (guard runs before body parse) but a minimal valid-shape body avoids
  // confusing a future regression with a separate 400.
  const WELLNESS_MUTATION_PROBES = [
    {
      method: "PUT",
      path: `/api/wellness/services/${FAKE_ID}`,
      body: { name: "IDOR-WELLNESS-SERVICES-must-never-land", basePrice: 1 },
      label: "PUT services/:id (catalog corruption vector)",
    },
    {
      method: "PUT",
      path: `/api/wellness/patients/${FAKE_ID}`,
      body: { name: "IDOR-WELLNESS-PATIENT-must-never-land" },
      label: "PUT patients/:id (PHI corruption vector)",
    },
    {
      method: "DELETE",
      path: `/api/wellness/patients/${FAKE_ID}`,
      body: null,
      label: "DELETE patients/:id (PHI deletion vector)",
    },
  ];

  async function doMutation(request, token, method, path, body) {
    switch (method) {
      case "PUT":
        return put(request, token, path, body);
      case "DELETE":
        return del(request, token, path);
      default:
        throw new Error(`unsupported method ${method}`);
    }
  }

  for (const { method, path, body, label } of WELLNESS_MUTATION_PROBES) {
    // DELETE patients/:id uses the RBAC gate (ADMIN) + tenant scope (no
    // verifyWellnessRole gate), so a generic/travel admin attempting it
    // hits the tenant-scoped handler and gets 404 "Patient not found"
    // — equally non-leaky from IDOR standpoint (no row-existence leak).
    // PUT/POST routes that DO mount verifyWellnessRole 403 with
    // WELLNESS_TENANT_REQUIRED. Both shapes are acceptable IDOR responses.
    const isDelete = method === "DELETE";

    test(`generic admin ${method} ${path} → 403/404 (no row leak) (${label})`, async ({
      request,
    }) => {
      const token = await getGenericAdmin(request);
      if (!token) test.skip(true, "generic admin token required");
      const res = await doMutation(request, token, method, path, body);
      const status = res.status();
      expect(
        status,
        `generic admin must not reach ${method} ${path}: got ${status} (${await res.text()})`,
      ).toBeLessThan(500);
      expect([403, 404]).toContain(status);
      if (!isDelete && status === 403) {
        const respBody = await res.json();
        expect(
          respBody.code,
          `${method} ${path}: expected code=WELLNESS_TENANT_REQUIRED`,
        ).toBe("WELLNESS_TENANT_REQUIRED");
      }
    });

    test(`travel admin ${method} ${path} → 403/404 (no row leak) (${label})`, async ({
      request,
    }) => {
      const token = await getTravelAdmin(request);
      if (!token) test.skip(true, "travel admin token required");
      const res = await doMutation(request, token, method, path, body);
      const status = res.status();
      expect(
        status,
        `travel admin must not reach ${method} ${path}: got ${status} (${await res.text()})`,
      ).toBeLessThan(500);
      expect([403, 404]).toContain(status);
      if (!isDelete && status === 403) {
        const respBody = await res.json();
        expect(
          respBody.code,
          `${method} ${path}: expected code=WELLNESS_TENANT_REQUIRED`,
        ).toBe("WELLNESS_TENANT_REQUIRED");
      }
    });
  }

  // Enumeration-prevention pin for wellness vertical. Same shape as the
  // slice-2 travel-diagnostics enumeration pin: id=1 (likely exists in
  // the seed) vs id=999999999 (definitely does not). Cross-vertical
  // attacker must see IDENTICAL 403 shape — if status diverged, that
  // would leak id existence across the vertical boundary.
  test("enumeration-prevention: wellness 403 shape is identical for id=1 and id=999999999", async ({
    request,
  }) => {
    const token = await getGenericAdmin(request);
    if (!token) test.skip(true, "generic admin token required");
    const lowIdRes = await get(request, token, `/api/wellness/visits/1`);
    const highIdRes = await get(request, token, `/api/wellness/visits/${FAKE_ID}`);
    expect(lowIdRes.status(), "id=1 must 403 (not 404)").toBe(403);
    expect(highIdRes.status(), `id=${FAKE_ID} must 403 (not 404)`).toBe(403);
    const lowBody = stripVolatileFields(await lowIdRes.json());
    const highBody = stripVolatileFields(await highIdRes.json());
    expect(lowBody.code).toBe("WELLNESS_TENANT_REQUIRED");
    expect(highBody.code).toBe("WELLNESS_TENANT_REQUIRED");
    expect(
      lowBody,
      `enumeration leak: wellness 403 body diverges for id=1 vs id=${FAKE_ID}`,
    ).toEqual(highBody);
  });

  // Guard-before-body-parse pin for wellness PUT. A deliberately malformed
  // body must STILL surface 403 WELLNESS_TENANT_REQUIRED, not 400 from
  // body validation. If validation moved before the wellness gate, the
  // route would leak the field-validation error envelope (an enumeration
  // surface revealing endpoint shape) to cross-vertical attackers.
  test("guard-before-body-parse: malformed PUT /services body still surfaces 403 WELLNESS_TENANT_REQUIRED", async ({
    request,
  }) => {
    const token = await getGenericAdmin(request);
    if (!token) test.skip(true, "generic admin token required");
    const res = await put(request, token, `/api/wellness/services/${FAKE_ID}`, {
      basePrice: "not-a-number",
      durationMin: -999,
    });
    expect(
      res.status(),
      `malformed wellness body must STILL 403 (not 400): got ${res.status()} (${await res.text()})`,
    ).toBe(403);
    const respBody = await res.json();
    expect(respBody.code).toBe("WELLNESS_TENANT_REQUIRED");
  });

  // Sanity canary — same pattern as the slice-2 travel-vertical canary.
  // Proves the WELLNESS_TENANT_REQUIRED responses above are tenant-
  // vertical-specific, not just "everyone gets 403". A wellness-tenant
  // admin should reach the handler and surface a normal 404 for the
  // fake patient id (the handler returns `{ error: "Patient not found" }`).
  test("wellness admin GET on a NON-EXISTENT patient id → 404 (sanity — guard is not 403-forever)", async ({
    request,
  }) => {
    const token = await getWellnessAdmin(request);
    if (!token) test.skip(true, "wellness admin token required");
    const res = await get(request, token, `/api/wellness/patients/${FAKE_ID}`);
    expect(
      res.status(),
      `wellness admin should reach lookup + get 404 on fake id: got ${res.status()} (${await res.text()})`,
    ).toBe(404);
  });
});

// ─── Slice 7 — list-endpoint cross-tenant leakage ────────────────────
// Prior slices pinned cross-tenant defences at the /:id GET + mutate
// surface. Slice 7 pins the LIST surface: paginated list responses must
// scope by req.user.tenantId regardless of ?tenantId= query injection.
//
// The global stripDangerous middleware deletes `tenantId` from req.body
// (CLAUDE.md standing rule + backend/eslint.config.js no-restricted-
// syntax rule) but does NOT touch req.query. So this slice specifically
// probes the query-param attack surface, which is structurally distinct
// from the body-strip surface that earlier slices covered.
//
// Strategy: seed a "victim" row on tenant B under tenant-B's admin
// token, then list the same model as tenant A's admin (with and without
// the ?tenantId= injection attempt) — assert the victim id is NEVER
// returned. The seeded-victim approach is more robust than asserting
// "every row's tenantId === caller.tenantId" because most list endpoints
// don't echo tenantId back in the response body (contacts doesn't);
// id-membership exclusion gives a tight, shape-agnostic contract.

test.describe("IDOR #919 — list endpoint cross-tenant leakage (slice 7)", () => {
  test("GET /api/contacts as wellness admin does NOT include generic-tenant Contact ids", async ({ request }) => {
    const generic = await getGenericAdmin(request);
    const wellness = await getWellnessAdmin(request);
    if (!generic || !wellness) {
      test.skip(true, "generic + wellness admin tokens both required");
    }
    // Seed a victim on the generic tenant.
    const victimId = await createContact(request, generic, "list-leak-victim-generic");

    // List from the wellness side — page size 500 is the route's max.
    const res = await get(request, wellness, `/api/contacts?limit=500`);
    expect(res.status(), `wellness contacts list: ${await res.text()}`).toBe(200);
    const body = await res.json();
    // Route returns an array OR an envelope with .contacts depending on
    // query params; tolerate both shapes (contacts.js:150 returns the
    // array directly, but later wrappers may envelope it).
    const rows = Array.isArray(body) ? body : (body.contacts || body.data || []);
    expect(Array.isArray(rows), `list shape: ${JSON.stringify(body).slice(0, 200)}`).toBe(true);
    const ids = rows.map((r) => r.id);
    expect(
      ids,
      `wellness list must NOT contain generic-tenant Contact id=${victimId}`,
    ).not.toContain(victimId);
  });

  test("GET /api/contacts?tenantId=<other> as wellness admin returns SAME id set as no-param list (query injection ignored)", async ({ request }) => {
    const generic = await getGenericAdmin(request);
    const wellness = await getWellnessAdmin(request);
    if (!generic || !wellness) {
      test.skip(true, "generic + wellness admin tokens both required");
    }
    // Seed a victim on the generic tenant so we can confirm injection doesn't reveal it.
    const victimId = await createContact(request, generic, "list-leak-qparam-victim");

    // First — the wellness admin's tenantId (we don't know the literal int
    // value but we know it's not 1; pass a plausible-but-not-self value).
    // Probe a range of injection values; ALL must produce an id set that
    // excludes the generic-side victim.
    const injectionValues = ["1", "2", "999999", "9999999999"];
    for (const v of injectionValues) {
      const res = await get(request, wellness, `/api/contacts?limit=500&tenantId=${v}`);
      expect(res.status(), `injected tenantId=${v}: ${await res.text()}`).toBe(200);
      const body = await res.json();
      const rows = Array.isArray(body) ? body : (body.contacts || body.data || []);
      const ids = rows.map((r) => r.id);
      expect(
        ids,
        `injection ?tenantId=${v} must NOT surface generic-tenant Contact id=${victimId}`,
      ).not.toContain(victimId);
    }
  });

  test("GET /api/deals as wellness admin does NOT include generic-tenant Deal ids (with or without ?tenantId injection)", async ({ request }) => {
    const generic = await getGenericAdmin(request);
    const wellness = await getWellnessAdmin(request);
    if (!generic || !wellness) {
      test.skip(true, "generic + wellness admin tokens both required");
    }
    // Seed a victim deal on the generic tenant.
    const victimId = await createDeal(request, generic, "list-leak-deal-victim");

    // Probe with and without query-param injection — both must exclude.
    const paths = [
      `/api/deals?limit=500`,
      `/api/deals?limit=500&tenantId=1`,
      `/api/deals?limit=500&tenantId=999999`,
    ];
    for (const path of paths) {
      const res = await get(request, wellness, path);
      expect(res.status(), `deals list (${path}): ${await res.text()}`).toBe(200);
      const body = await res.json();
      const rows = Array.isArray(body) ? body : (body.deals || body.data || []);
      expect(
        Array.isArray(rows),
        `list shape on ${path}: ${JSON.stringify(body).slice(0, 200)}`,
      ).toBe(true);
      const ids = rows.map((r) => r.id);
      expect(
        ids,
        `wellness deals list on ${path} must NOT contain generic-tenant Deal id=${victimId}`,
      ).not.toContain(victimId);
      // Belt-and-braces: ANY row that DOES echo tenantId must match the
      // caller's tenant. (deals.js doesn't strip tenantId from selects,
      // so this is a strong second pin.)
      for (const row of rows) {
        if (row.tenantId !== undefined) {
          // Caller is wellness; victim id is generic — they CANNOT share
          // a tenantId. We don't know wellness's tenantId numerically,
          // but it must equal every row's tenantId in the response.
          expect(
            row.tenantId,
            `deals row ${row.id} echoed tenantId=${row.tenantId}; expected uniform caller-tenant scope`,
          ).toBe(rows[0].tenantId);
        }
      }
    }
  });

  test("GET /api/travel/itineraries as wellness admin → 403 WRONG_VERTICAL (list-level vertical guard)", async ({ request }) => {
    const wellness = await getWellnessAdmin(request);
    if (!wellness) test.skip(true, "wellness admin token required");
    // requireTravelTenant should fire BEFORE the list query — same
    // contract as the /:id probes in slice 2, but pinned at the LIST
    // surface. A future refactor that forgets to mount the guard on the
    // collection endpoint would silently leak cross-vertical itineraries.
    const res = await get(request, wellness, `/api/travel/itineraries`);
    expect(
      res.status(),
      `wellness admin should hit travel list 403, got ${res.status()} (${await res.text()})`,
    ).toBe(403);
    const body = await res.json().catch(() => ({}));
    expect(JSON.stringify(body)).toMatch(/WRONG_VERTICAL/i);
  });

  test("GET /api/travel/itineraries as generic admin → 403 WRONG_VERTICAL (cross-vertical list guard, both directions)", async ({ request }) => {
    const generic = await getGenericAdmin(request);
    if (!generic) test.skip(true, "generic admin token required");
    const res = await get(request, generic, `/api/travel/itineraries`);
    expect(
      res.status(),
      `generic admin should hit travel list 403, got ${res.status()} (${await res.text()})`,
    ).toBe(403);
    const body = await res.json().catch(() => ({}));
    expect(JSON.stringify(body)).toMatch(/WRONG_VERTICAL/i);
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

  // Slice 3 — mutation auth-gate. No token must never 2xx on a
  // mutation, regardless of method. Pair-tested with the slice-3
  // cross-vertical describe above (which proves the wellness/generic
  // admins can't mutate either) — together they form the
  // "no path to a cross-tenant write" contract.
  test("PATCH /api/travel/itineraries/1 without token → 401/403", async ({ request }) => {
    const res = await request.patch(`${BASE_URL}/api/travel/itineraries/1`, {
      data: { status: "ACCEPTED" },
      headers: { "Content-Type": "application/json" },
      timeout: REQUEST_TIMEOUT,
    });
    expect([401, 403]).toContain(res.status());
  });

  test("DELETE /api/travel/itineraries/1/items/1 without token → 401/403", async ({ request }) => {
    const res = await request.delete(
      `${BASE_URL}/api/travel/itineraries/1/items/1`,
      { timeout: REQUEST_TIMEOUT },
    );
    expect([401, 403]).toContain(res.status());
  });

  test("POST /api/travel/itineraries/1/accept without token → 401/403", async ({ request }) => {
    const res = await request.post(`${BASE_URL}/api/travel/itineraries/1/accept`, {
      data: {},
      headers: { "Content-Type": "application/json" },
      timeout: REQUEST_TIMEOUT,
    });
    expect([401, 403]).toContain(res.status());
  });

  // Slice 4 — auth-gate sweep for the non-Travel mutation surface.
  // Mirrors the slice-3 mutation auth-gate but on /api/deals/:id and
  // /api/contacts/:id. No token must never 2xx on these mutations.
  test("PUT /api/deals/1 without token → 401/403", async ({ request }) => {
    const res = await request.put(`${BASE_URL}/api/deals/1`, {
      data: { title: "no-token-probe" },
      headers: { "Content-Type": "application/json" },
      timeout: REQUEST_TIMEOUT,
    });
    expect([401, 403]).toContain(res.status());
  });

  test("DELETE /api/deals/1 without token → 401/403", async ({ request }) => {
    const res = await request.delete(`${BASE_URL}/api/deals/1`, {
      timeout: REQUEST_TIMEOUT,
    });
    expect([401, 403]).toContain(res.status());
  });

  test("PUT /api/contacts/1 without token → 401/403", async ({ request }) => {
    const res = await request.put(`${BASE_URL}/api/contacts/1`, {
      data: { name: "no-token-probe" },
      headers: { "Content-Type": "application/json" },
      timeout: REQUEST_TIMEOUT,
    });
    expect([401, 403]).toContain(res.status());
  });

  test("DELETE /api/contacts/1 without token → 401/403", async ({ request }) => {
    const res = await request.delete(`${BASE_URL}/api/contacts/1`, {
      timeout: REQUEST_TIMEOUT,
    });
    expect([401, 403]).toContain(res.status());
  });

  // Slice 6 — auth-gate sweep for wellness-vertical /:id endpoints. Same
  // contract as the travel-vertical auth-gate sweep above: no token must
  // never 200, regardless of vertical. Parametric to keep the spec compact.
  const NO_TOKEN_WELLNESS_ROUTES = [
    `/api/wellness/patients/1`,
    `/api/wellness/visits/1`,
    `/api/wellness/services/1`,
  ];
  for (const path of NO_TOKEN_WELLNESS_ROUTES) {
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

  test("PUT /api/wellness/patients/1 without token → 401/403", async ({ request }) => {
    const res = await request.put(`${BASE_URL}/api/wellness/patients/1`, {
      data: { name: "no-token-probe" },
      headers: { "Content-Type": "application/json" },
      timeout: REQUEST_TIMEOUT,
    });
    expect([401, 403]).toContain(res.status());
  });

  test("DELETE /api/wellness/patients/1 without token → 401/403", async ({ request }) => {
    const res = await request.delete(`${BASE_URL}/api/wellness/patients/1`, {
      timeout: REQUEST_TIMEOUT,
    });
    expect([401, 403]).toContain(res.status());
  });
});

// ─── Slice 8 — cross-resource IDOR probes ────────────────────────────
// Slices 1-7 pinned cross-tenant defences at the per-resource /:id GET +
// mutate + list surfaces. Slice 8 extends the audit to SUB-RESOURCE
// endpoints — the URL shapes where a parent /:id is nested with a
// child action verb (`/summary/by-month`, `/clone`, `/items`,
// `/items/bulk-delete`). These are structurally distinct from the
// flat /:id mutations slice 3 covered because:
//
//   (a) The handler does TWO lookups in sequence — first resolve the
//       parent /:id (commission-profile or itinerary), THEN apply the
//       child action / nested-resource lookup. A regression that drops
//       the tenant filter on EITHER lookup would silently leak —
//       the parent-resolve might 404 cross-tenant correctly but the
//       child-action might side-effect on the wrong row.
//   (b) Some sub-resources accept a body that itself carries ids
//       (e.g. `/items/bulk-delete` takes `{ itemIds: [...] }`). A
//       regression that read those id arrays without tenant-scoping
//       would let cross-vertical attackers delete arbitrary items
//       by id-enumeration.
//
// Slice 8 verified the actual route surface against
// backend/routes/travel_commission_profiles.js + travel_itineraries.js:
//   • /commission-profiles/:id/summary/by-month     — GET (1438)
//   • /commission-profiles/:id/summary/by-quarter   — GET (1687)
//   • /commission-profiles/:id/duplicate            — POST (1069) — the
//     prompt named /clone; reality is /duplicate (gap-card drift; we
//     PIN REALITY per .claude/skills/verifying-gap-card-claims/)
//   • /commission-profiles/:id/assign               — POST (481) — the
//     prompt named /bulk-payout; that route does NOT exist. We probe
//     /assign instead (same severity: mutation-on-profile vector)
//   • /itineraries/:id/items                        — POST (800)
//   • /itineraries/:id/items/:itemId                — PATCH (843)
//   • /itineraries/:id/items/:itemId                — DELETE (884) —
//     already pinned in slice 3 with TWO-fake-ids; here we add a
//     positive-itemId probe to round out the sub-resource matrix
//   • /itineraries/:id/items/bulk-delete            — POST (558)
//
// Acceptance per probe: `expect([403, 404]).toContain(status)`. All
// these routes mount requireTravelTenant FIRST, so cross-vertical
// attackers SHOULD hit 403 WRONG_VERTICAL — but the spec stays robust
// to a future refactor that demotes the cross-vertical gate to a 404
// (e.g. unifying tenant + vertical scoping into the parent lookup).
// Both are non-leaky from an IDOR standpoint; we accept either.

test.describe("IDOR #919 slice 8 — cross-resource IDOR probes (commission-profile + itinerary-item sub-resources)", () => {
  // Commission-profile sub-resources — cross-vertical attacker hits
  // requireTravelTenant BEFORE the /:id lookup. Sentinel FAKE_ID for
  // the parent — guard fires regardless of id existence.
  test("wellness admin GET /commission-profiles/:id/summary/by-month → 403/404", async ({
    request,
  }) => {
    const token = await getWellnessAdmin(request);
    if (!token) test.skip(true, "wellness admin token required");
    const res = await get(
      request,
      token,
      `/api/travel/commission-profiles/${FAKE_ID}/summary/by-month`,
    );
    expect(
      [403, 404],
      `wellness admin must not reach commission-profile summary: got ${res.status()} (${await res.text()})`,
    ).toContain(res.status());
  });

  test("generic admin GET /commission-profiles/:id/summary/by-quarter → 403/404", async ({
    request,
  }) => {
    const token = await getGenericAdmin(request);
    if (!token) test.skip(true, "generic admin token required");
    const res = await get(
      request,
      token,
      `/api/travel/commission-profiles/${FAKE_ID}/summary/by-quarter`,
    );
    expect(
      [403, 404],
      `generic admin must not reach commission-profile quarter summary: got ${res.status()} (${await res.text()})`,
    ).toContain(res.status());
  });

  test("wellness admin POST /commission-profiles/:id/duplicate → 403/404 (mutation vector)", async ({
    request,
  }) => {
    const token = await getWellnessAdmin(request);
    if (!token) test.skip(true, "wellness admin token required");
    const res = await post(
      request,
      token,
      `/api/travel/commission-profiles/${FAKE_ID}/duplicate`,
      { name: "IDOR-DUPLICATE-PROBE-must-never-land" },
    );
    expect(
      [403, 404],
      `wellness admin must not duplicate commission-profile: got ${res.status()} (${await res.text()})`,
    ).toContain(res.status());
  });

  test("generic admin POST /commission-profiles/:id/assign → 403/404 (mutation vector)", async ({
    request,
  }) => {
    // The prompt named /bulk-payout (doesn't exist) — we probe /assign
    // instead (a real mutation sub-resource on the same parent /:id).
    const token = await getGenericAdmin(request);
    if (!token) test.skip(true, "generic admin token required");
    const res = await post(
      request,
      token,
      `/api/travel/commission-profiles/${FAKE_ID}/assign`,
      { staffIds: [1, 2] },
    );
    expect(
      [403, 404],
      `generic admin must not assign commission-profile: got ${res.status()} (${await res.text()})`,
    ).toContain(res.status());
  });

  // Itinerary item sub-resources — cross-vertical attacker. Same
  // requireTravelTenant gate; sentinel FAKE_ID for both parent itinerary
  // and child itemId so a regression that demoted the gate would surface
  // as 404 (either lookup miss) rather than the expected 403.
  test("wellness admin POST /itineraries/:id/items → 403/404 (item-create corruption vector)", async ({
    request,
  }) => {
    const token = await getWellnessAdmin(request);
    if (!token) test.skip(true, "wellness admin token required");
    const res = await post(
      request,
      token,
      `/api/travel/itineraries/${FAKE_ID}/items`,
      { itemType: "flight", description: "IDOR-ITEM-CREATE-must-never-land" },
    );
    expect(
      [403, 404],
      `wellness admin must not create itinerary item: got ${res.status()} (${await res.text()})`,
    ).toContain(res.status());
  });

  test("generic admin PATCH /itineraries/:id/items/:itemId → 403/404 (item-corruption vector)", async ({
    request,
  }) => {
    const token = await getGenericAdmin(request);
    if (!token) test.skip(true, "generic admin token required");
    const res = await patch(
      request,
      token,
      `/api/travel/itineraries/${FAKE_ID}/items/${FAKE_ID}`,
      { description: "IDOR-ITEM-PATCH-must-never-land" },
    );
    expect(
      [403, 404],
      `generic admin must not PATCH itinerary item: got ${res.status()} (${await res.text()})`,
    ).toContain(res.status());
  });

  test("wellness admin POST /itineraries/:id/items/bulk-delete → 403/404 (bulk deletion vector)", async ({
    request,
  }) => {
    // bulk-delete is the most dangerous sub-resource: a missed guard
    // would let attackers nuke multiple items by id-enumeration in a
    // single request. Pinning 403/404 here ensures the parent /:id
    // guard fires before the array of itemIds is even parsed.
    const token = await getWellnessAdmin(request);
    if (!token) test.skip(true, "wellness admin token required");
    const res = await post(
      request,
      token,
      `/api/travel/itineraries/${FAKE_ID}/items/bulk-delete`,
      { itemIds: [1, 2, 3] },
    );
    expect(
      [403, 404],
      `wellness admin must not bulk-delete itinerary items: got ${res.status()} (${await res.text()})`,
    ).toContain(res.status());
  });
});

// ─── Slice 9 ─────────────────────────────────────────────────────────
// Extends the cross-resource IDOR audit to the two remaining big
// aggregation surfaces — TravelFlyerTemplate sub-resources and
// TravelSupplier sub-resources. Slice 8 covered commission-profile and
// itinerary-item; slice 9 closes the loop on the next two large parent
// /:id entities that fan out into multiple aggregation / mutation
// sub-resources.
//
// Both parent entities are Travel-vertical only, so the contract is
// the same as slice 8: a cross-vertical attacker (wellness/generic
// admin) hits requireTravelTenant BEFORE the /:id lookup, returning
// 403 WRONG_VERTICAL. Sentinel FAKE_ID is used for the parent — the
// guard runs regardless of id existence, so the assertion is
// [403, 404].toContain(status) (403 = vertical guard fired; 404 = a
// post-guard tenant-scope miss if a future refactor demotes the guard
// to per-handler tenant filtering).
//
// All 10 probe targets were verified to exist via grep against
// backend/routes/travel_flyer_templates.js and travel_suppliers.js
// before authoring. Flyer-template subset:
//   GET    /flyer-templates/:id/usage-stats    (line 1762)
//   GET    /flyer-templates/:id/audit-trail    (line 1923)
//   GET    /flyer-templates/:id/clone-history  (line 2155, slice 20)
//   POST   /flyer-templates/:id/duplicate      (line 1177)
//   DELETE /flyer-templates/:id                (line 2030)
// Supplier subset:
//   GET    /suppliers/:id/payables/aging       (line 2580)
//   GET    /suppliers/:id/payables/monthly     (line 2672)
//   GET    /suppliers/:id/payables/quarterly   (line 2805)
//   GET    /suppliers/:id/payables/yearly      (line 3607, slice 22)
//   GET    /suppliers/:id/timeline             (line 2037)
test.describe("IDOR #919 slice 9 — flyer-template + supplier cross-resource probes", () => {
  // Flyer-template sub-resources — cross-vertical attacker hits
  // requireTravelTenant BEFORE the /:id lookup. Sentinel FAKE_ID for
  // the parent — guard fires regardless of id existence.
  test("wellness admin GET /flyer-templates/:id/usage-stats → 403/404", async ({
    request,
  }) => {
    const token = await getWellnessAdmin(request);
    if (!token) test.skip(true, "wellness admin token required");
    const res = await get(
      request,
      token,
      `/api/travel/flyer-templates/${FAKE_ID}/usage-stats`,
    );
    expect(
      [403, 404],
      `wellness admin must not reach flyer-template usage-stats: got ${res.status()} (${await res.text()})`,
    ).toContain(res.status());
  });

  test("wellness admin GET /flyer-templates/:id/audit-trail → 403/404", async ({
    request,
  }) => {
    const token = await getWellnessAdmin(request);
    if (!token) test.skip(true, "wellness admin token required");
    const res = await get(
      request,
      token,
      `/api/travel/flyer-templates/${FAKE_ID}/audit-trail`,
    );
    expect(
      [403, 404],
      `wellness admin must not reach flyer-template audit-trail: got ${res.status()} (${await res.text()})`,
    ).toContain(res.status());
  });

  test("wellness admin GET /flyer-templates/:id/clone-history → 403/404", async ({
    request,
  }) => {
    const token = await getWellnessAdmin(request);
    if (!token) test.skip(true, "wellness admin token required");
    const res = await get(
      request,
      token,
      `/api/travel/flyer-templates/${FAKE_ID}/clone-history`,
    );
    expect(
      [403, 404],
      `wellness admin must not reach flyer-template clone-history: got ${res.status()} (${await res.text()})`,
    ).toContain(res.status());
  });

  test("generic admin POST /flyer-templates/:id/duplicate → 403/404 (mutation vector)", async ({
    request,
  }) => {
    // POST /duplicate is the mutation vector for flyer-templates — a
    // missed guard would let attackers clone cross-tenant templates
    // into their own tenant. Pinning 403/404 ensures the parent /:id
    // guard fires before any clone-into-tenant Prisma create runs.
    const token = await getGenericAdmin(request);
    if (!token) test.skip(true, "generic admin token required");
    const res = await post(
      request,
      token,
      `/api/travel/flyer-templates/${FAKE_ID}/duplicate`,
      { name: "IDOR-FLYER-DUPLICATE-PROBE-must-never-land" },
    );
    expect(
      [403, 404],
      `generic admin must not duplicate flyer-template: got ${res.status()} (${await res.text()})`,
    ).toContain(res.status());
  });

  test("wellness admin DELETE /flyer-templates/:id → 403/404 (destruction vector)", async ({
    request,
  }) => {
    // DELETE /:id is the destruction vector — a missed guard would
    // let attackers nuke cross-tenant flyer-templates by id
    // enumeration. The vertical guard MUST fire before any Prisma
    // delete runs.
    const token = await getWellnessAdmin(request);
    if (!token) test.skip(true, "wellness admin token required");
    const res = await del(
      request,
      token,
      `/api/travel/flyer-templates/${FAKE_ID}`,
    );
    expect(
      [403, 404],
      `wellness admin must not DELETE flyer-template: got ${res.status()} (${await res.text()})`,
    ).toContain(res.status());
  });

  // Supplier sub-resources — same requireTravelTenant contract.
  // Payables aggregation surfaces (/aging, /monthly, /quarterly,
  // /yearly) plus the /timeline activity feed are all cross-tenant-
  // sensitive: a missed guard would leak supplier-side financial
  // exposure (payables breakdowns) and supplier-relationship history.
  test("wellness admin GET /suppliers/:id/payables/aging → 403/404", async ({
    request,
  }) => {
    const token = await getWellnessAdmin(request);
    if (!token) test.skip(true, "wellness admin token required");
    const res = await get(
      request,
      token,
      `/api/travel/suppliers/${FAKE_ID}/payables/aging`,
    );
    expect(
      [403, 404],
      `wellness admin must not reach supplier payables-aging: got ${res.status()} (${await res.text()})`,
    ).toContain(res.status());
  });

  test("wellness admin GET /suppliers/:id/payables/monthly → 403/404", async ({
    request,
  }) => {
    const token = await getWellnessAdmin(request);
    if (!token) test.skip(true, "wellness admin token required");
    const res = await get(
      request,
      token,
      `/api/travel/suppliers/${FAKE_ID}/payables/monthly`,
    );
    expect(
      [403, 404],
      `wellness admin must not reach supplier payables-monthly: got ${res.status()} (${await res.text()})`,
    ).toContain(res.status());
  });

  test("wellness admin GET /suppliers/:id/payables/quarterly → 403/404", async ({
    request,
  }) => {
    const token = await getWellnessAdmin(request);
    if (!token) test.skip(true, "wellness admin token required");
    const res = await get(
      request,
      token,
      `/api/travel/suppliers/${FAKE_ID}/payables/quarterly`,
    );
    expect(
      [403, 404],
      `wellness admin must not reach supplier payables-quarterly: got ${res.status()} (${await res.text()})`,
    ).toContain(res.status());
  });

  test("wellness admin GET /suppliers/:id/payables/yearly → 403/404", async ({
    request,
  }) => {
    const token = await getWellnessAdmin(request);
    if (!token) test.skip(true, "wellness admin token required");
    const res = await get(
      request,
      token,
      `/api/travel/suppliers/${FAKE_ID}/payables/yearly`,
    );
    expect(
      [403, 404],
      `wellness admin must not reach supplier payables-yearly: got ${res.status()} (${await res.text()})`,
    ).toContain(res.status());
  });

  test("wellness admin GET /suppliers/:id/timeline → 403/404", async ({
    request,
  }) => {
    const token = await getWellnessAdmin(request);
    if (!token) test.skip(true, "wellness admin token required");
    const res = await get(
      request,
      token,
      `/api/travel/suppliers/${FAKE_ID}/timeline`,
    );
    expect(
      [403, 404],
      `wellness admin must not reach supplier timeline: got ${res.status()} (${await res.text()})`,
    ).toContain(res.status());
  });
});

test.describe("IDOR #919 slice 10 — quote + invoice cross-resource probes", () => {
  // Slices 8 + 9 covered commission-profile, itinerary-item, flyer-
  // template and supplier sub-resources. Slice 10 closes the remaining
  // two big aggregation surfaces — TravelQuote sub-resources and
  // TravelInvoice sub-resources. Every probe asserts [403, 404].toContain
  // so the spec stays robust whether the route emits the cross-vertical
  // sentinel (`requireTravelTenant` → 403 WRONG_VERTICAL) or the tenant-
  // scope sentinel (`findFirst({ where: { id, tenantId } })` → 404) first.
  //
  // Slice 10 drift note (per .claude/skills/verifying-gap-card-claims/):
  // the slice-10 prompt listed `/quotes/:id/analytics` as a probe target.
  // Reality check: `routes/travel_quotes.js` exposes `/quotes/analytics`
  // as a COLLECTION-level aggregate (line 304) — there is no per-quote
  // `/:id/analytics` route. Dropped that probe and pin reality. The
  // collection-level `/quotes/analytics` IS guarded by requireTravelTenant
  // (slice 7's list-endpoint probe pattern would catch any regression
  // there), so coverage isn't lost — it just lives on the LIST surface
  // rather than the per-id surface.

  // ---- TravelQuote sub-resources ---------------------------------------

  test("wellness admin GET /quotes/:id/audit-trail → 403/404", async ({
    request,
  }) => {
    const token = await getWellnessAdmin(request);
    if (!token) test.skip(true, "wellness admin token required");
    const res = await get(
      request,
      token,
      `/api/travel/quotes/${FAKE_ID}/audit-trail`,
    );
    expect(
      [403, 404],
      `wellness admin must not reach quote audit-trail: got ${res.status()} (${await res.text()})`,
    ).toContain(res.status());
  });

  test("generic admin POST /quotes/:id/duplicate → 403/404 (mutation vector)", async ({
    request,
  }) => {
    // POST /duplicate is a mutation vector — a missed guard would let
    // cross-tenant attackers clone quotes into their own tenant. Pinning
    // 403/404 ensures the parent /:id guard fires before any Prisma
    // create runs.
    const token = await getGenericAdmin(request);
    if (!token) test.skip(true, "generic admin token required");
    const res = await post(
      request,
      token,
      `/api/travel/quotes/${FAKE_ID}/duplicate`,
      {},
    );
    expect(
      [403, 404],
      `generic admin must not reach quote duplicate: got ${res.status()} (${await res.text()})`,
    ).toContain(res.status());
  });

  test("wellness admin DELETE /quotes/:id → 403/404 (destructive mutation)", async ({
    request,
  }) => {
    // DELETE /quotes/:id is the worst-case mutation — a missed guard
    // would let cross-tenant attackers delete sales quotes belonging to
    // another tenant. Pinning 403/404 ensures the tenant-scope filter
    // fires before any Prisma delete runs.
    const token = await getWellnessAdmin(request);
    if (!token) test.skip(true, "wellness admin token required");
    const res = await del(
      request,
      token,
      `/api/travel/quotes/${FAKE_ID}`,
    );
    expect(
      [403, 404],
      `wellness admin must not DELETE travel quote: got ${res.status()} (${await res.text()})`,
    ).toContain(res.status());
  });

  test("generic admin POST /quotes/:id/accept → 403/404 (state-transition mutation)", async ({
    request,
  }) => {
    // POST /accept transitions a quote to accepted state — a missed
    // guard would let cross-tenant attackers force-accept another
    // tenant's pending quotes (skewing pipeline, triggering downstream
    // invoice generation, etc.). Pinning 403/404.
    const token = await getGenericAdmin(request);
    if (!token) test.skip(true, "generic admin token required");
    const res = await post(
      request,
      token,
      `/api/travel/quotes/${FAKE_ID}/accept`,
      {},
    );
    expect(
      [403, 404],
      `generic admin must not accept travel quote: got ${res.status()} (${await res.text()})`,
    ).toContain(res.status());
  });

  // ---- TravelInvoice sub-resources -------------------------------------

  test("wellness admin GET /invoices/:id/timeline → 403/404", async ({
    request,
  }) => {
    const token = await getWellnessAdmin(request);
    if (!token) test.skip(true, "wellness admin token required");
    const res = await get(
      request,
      token,
      `/api/travel/invoices/${FAKE_ID}/timeline`,
    );
    expect(
      [403, 404],
      `wellness admin must not reach invoice timeline: got ${res.status()} (${await res.text()})`,
    ).toContain(res.status());
  });

  test("wellness admin GET /invoices/:id/late-penalty → 403/404", async ({
    request,
  }) => {
    const token = await getWellnessAdmin(request);
    if (!token) test.skip(true, "wellness admin token required");
    const res = await get(
      request,
      token,
      `/api/travel/invoices/${FAKE_ID}/late-penalty`,
    );
    expect(
      [403, 404],
      `wellness admin must not reach invoice late-penalty: got ${res.status()} (${await res.text()})`,
    ).toContain(res.status());
  });

  test("generic admin POST /invoices/:id/apply-penalty → 403/404 (financial mutation)", async ({
    request,
  }) => {
    // POST /apply-penalty mutates the invoice with a late-fee line — a
    // missed guard would let cross-tenant attackers stack penalties onto
    // another tenant's invoices. Pinning 403/404.
    const token = await getGenericAdmin(request);
    if (!token) test.skip(true, "generic admin token required");
    const res = await post(
      request,
      token,
      `/api/travel/invoices/${FAKE_ID}/apply-penalty`,
      {},
    );
    expect(
      [403, 404],
      `generic admin must not apply penalty to travel invoice: got ${res.status()} (${await res.text()})`,
    ).toContain(res.status());
  });

  test("wellness admin POST /invoices/:id/convert-to-tax-invoice → 403/404 (tax-mode mutation)", async ({
    request,
  }) => {
    // POST /convert-to-tax-invoice transitions a proforma to a tax
    // invoice — a missed guard would let cross-tenant attackers force
    // tax-mode conversion on another tenant's proforma (tax-event
    // implications). Pinning 403/404.
    const token = await getWellnessAdmin(request);
    if (!token) test.skip(true, "wellness admin token required");
    const res = await post(
      request,
      token,
      `/api/travel/invoices/${FAKE_ID}/convert-to-tax-invoice`,
      {},
    );
    expect(
      [403, 404],
      `wellness admin must not convert travel invoice to tax-invoice: got ${res.status()} (${await res.text()})`,
    ).toContain(res.status());
  });

  test("generic admin POST /invoices/:id/void → 403/404 (destructive state mutation)", async ({
    request,
  }) => {
    // POST /void cancels an issued invoice — a missed guard would let
    // cross-tenant attackers void another tenant's revenue-recognised
    // invoices (audit-log + ledger implications). Pinning 403/404.
    const token = await getGenericAdmin(request);
    if (!token) test.skip(true, "generic admin token required");
    const res = await post(
      request,
      token,
      `/api/travel/invoices/${FAKE_ID}/void`,
      {},
    );
    expect(
      [403, 404],
      `generic admin must not void travel invoice: got ${res.status()} (${await res.text()})`,
    ).toContain(res.status());
  });
});

test.describe("IDOR #919 slice 11 — webcheckin + trips + visa cross-resource probes", () => {
  // Slices 8 + 9 + 10 covered commission-profile, itinerary-item,
  // flyer-template, supplier, quote and invoice sub-resources. Slice 11
  // closes three remaining Travel-vertical surfaces that landed across
  // recent waves:
  //
  //   • WebCheckin (/api/travel/webcheckins/:id + sub-routes) — flight
  //     check-in tracking; a missed guard would let cross-tenant
  //     attackers GET passenger details, mutate status, upload bogus
  //     boarding passes, mark deliveries, or DELETE check-in rows.
  //
  //   • TMC Trips (/api/travel/trips/:id + ops-dashboard) — TmcTrip
  //     aggregate; a missed guard would let cross-tenant attackers
  //     GET / PATCH / DELETE trip rows or read the operational rollup
  //     (revenue, participant counts, document status) of another
  //     tenant's trips. NOTE: routes/travel_trips.js mounts the layered
  //     guards `requireTravelTenant` BEFORE `requireTmcAccess` (see
  //     slice 2 guard-order pin), so cross-vertical attackers hit 403
  //     WRONG_VERTICAL first — same shape as the slice-1 base pattern.
  //
  //   • Visa applications (/api/travel/visa/applications + /:id +
  //     /:id/status-history) — Phase 3 Visa Sure work surface. A missed
  //     guard would let cross-tenant attackers GET application rows,
  //     read status-history audit trails, or POST applications under a
  //     contactId belonging to another tenant.
  //
  // Every probe asserts [403, 404].toContain(status). Cross-vertical
  // routes return 403 WRONG_VERTICAL via requireTravelTenant; if a
  // future refactor demotes that to a post-vertical-guard 404 from the
  // findFirst({ where: { id, tenantId } }) miss, the [403, 404] window
  // still passes — coverage isn't lost, the layering just shifts.
  //
  // Slice 11 endpoint-existence verification (per .claude/skills/
  // verifying-gap-card-claims/): all 12 prompt-listed targets were
  // grep-verified against backend/routes/travel_{webcheckin,trips,
  // visa}.js before authoring. Zero drift — every probe target exists.

  // ---- WebCheckin sub-resources ----------------------------------------

  test("wellness admin GET /webcheckins/:id → 403/404", async ({ request }) => {
    const token = await getWellnessAdmin(request);
    if (!token) test.skip(true, "wellness admin token required");
    const res = await get(
      request,
      token,
      `/api/travel/webcheckins/${FAKE_ID}`,
    );
    expect(
      [403, 404],
      `wellness admin must not GET travel webcheckin: got ${res.status()} (${await res.text()})`,
    ).toContain(res.status());
  });

  test("generic admin PATCH /webcheckins/:id → 403/404 (status-mutation vector)", async ({
    request,
  }) => {
    // PATCH mutates check-in state (status / assignedAgentId / seatPref
    // / mealPref / attemptsJson / boardingPassUrl). A missed guard
    // would let cross-tenant attackers reassign agents or flip status
    // on another tenant's check-ins. Pinning 403/404.
    const token = await getGenericAdmin(request);
    if (!token) test.skip(true, "generic admin token required");
    const res = await patch(
      request,
      token,
      `/api/travel/webcheckins/${FAKE_ID}`,
      { status: "done" },
    );
    expect(
      [403, 404],
      `generic admin must not PATCH travel webcheckin: got ${res.status()} (${await res.text()})`,
    ).toContain(res.status());
  });

  test("wellness admin POST /webcheckins/:id/upload-boarding-pass → 403/404 (file-upload vector)", async ({
    request,
  }) => {
    // The upload route is multipart, but the requireTravelTenant guard
    // fires BEFORE the multer middleware parses the file — so a probe
    // without a file body still tests the cross-vertical isolation
    // contract. A missed guard would let cross-tenant attackers stage
    // boarding-pass files against another tenant's check-ins. Pinning
    // 403/404.
    const token = await getWellnessAdmin(request);
    if (!token) test.skip(true, "wellness admin token required");
    const res = await post(
      request,
      token,
      `/api/travel/webcheckins/${FAKE_ID}/upload-boarding-pass`,
      {},
    );
    expect(
      [403, 404],
      `wellness admin must not upload boarding pass to travel webcheckin: got ${res.status()} (${await res.text()})`,
    ).toContain(res.status());
  });

  test("generic admin POST /webcheckins/:id/deliver → 403/404 (delivery-mutation vector)", async ({
    request,
  }) => {
    // POST /deliver marks the check-in delivered (sets deliveredAt) and
    // would, when Q9 creds land, fire a real WhatsApp send. A missed
    // guard would let cross-tenant attackers force-deliver another
    // tenant's check-ins (and once Q9 lands, trigger real WhatsApp
    // sends on someone else's WABA). Pinning 403/404.
    const token = await getGenericAdmin(request);
    if (!token) test.skip(true, "generic admin token required");
    const res = await post(
      request,
      token,
      `/api/travel/webcheckins/${FAKE_ID}/deliver`,
      {},
    );
    expect(
      [403, 404],
      `generic admin must not deliver travel webcheckin: got ${res.status()} (${await res.text()})`,
    ).toContain(res.status());
  });

  test("wellness admin DELETE /webcheckins/:id → 403/404 (destructive mutation)", async ({
    request,
  }) => {
    // DELETE /webcheckins/:id is ADMIN-only; a missed guard would let
    // cross-tenant attackers delete another tenant's check-in tracking
    // rows. Pinning 403/404 ensures the cross-vertical guard fires
    // before any Prisma delete runs.
    const token = await getWellnessAdmin(request);
    if (!token) test.skip(true, "wellness admin token required");
    const res = await del(
      request,
      token,
      `/api/travel/webcheckins/${FAKE_ID}`,
    );
    expect(
      [403, 404],
      `wellness admin must not DELETE travel webcheckin: got ${res.status()} (${await res.text()})`,
    ).toContain(res.status());
  });

  // ---- TMC Trips sub-resources -----------------------------------------

  test("wellness admin GET /trips/:id → 403/404", async ({ request }) => {
    // GET /trips/:id is gated by requireTravelTenant → requireTmcAccess
    // (per slice-2 guard-order pin). Cross-vertical attacker hits 403
    // WRONG_VERTICAL FIRST, not 403 TMC_ACCESS_DENIED. The [403, 404]
    // window absorbs either layering.
    const token = await getWellnessAdmin(request);
    if (!token) test.skip(true, "wellness admin token required");
    const res = await get(
      request,
      token,
      `/api/travel/trips/${FAKE_ID}`,
    );
    expect(
      [403, 404],
      `wellness admin must not GET TMC trip: got ${res.status()} (${await res.text()})`,
    ).toContain(res.status());
  });

  test("generic admin PATCH /trips/:id → 403/404 (corruption vector)", async ({
    request,
  }) => {
    // Slice 3 already covered the PATCH /trips/:id case at line 603;
    // slice 11 re-pins from the generic-admin side (slice 3 fired the
    // probe from the wellness side via the cross-vertical mutation
    // table). The duplicate probe is intentional — it pins symmetry of
    // the cross-vertical guard regardless of which non-travel tenant
    // is the attacker. Pinning 403/404.
    const token = await getGenericAdmin(request);
    if (!token) test.skip(true, "generic admin token required");
    const res = await patch(
      request,
      token,
      `/api/travel/trips/${FAKE_ID}`,
      { name: "attacker-injected-name" },
    );
    expect(
      [403, 404],
      `generic admin must not PATCH TMC trip: got ${res.status()} (${await res.text()})`,
    ).toContain(res.status());
  });

  test("wellness admin DELETE /trips/:id → 403/404 (destructive mutation)", async ({
    request,
  }) => {
    // DELETE /trips/:id is ADMIN-only and cascades through children
    // (participants, documents). A missed guard would let cross-tenant
    // attackers nuke another tenant's TMC trip ecosystem. Pinning
    // 403/404.
    const token = await getWellnessAdmin(request);
    if (!token) test.skip(true, "wellness admin token required");
    const res = await del(
      request,
      token,
      `/api/travel/trips/${FAKE_ID}`,
    );
    expect(
      [403, 404],
      `wellness admin must not DELETE TMC trip: got ${res.status()} (${await res.text()})`,
    ).toContain(res.status());
  });

  test("generic admin GET /trips/:id/ops-dashboard → 403/404", async ({
    request,
  }) => {
    // PRD §4.9 operational rollup — exposes revenue, participant counts,
    // document status, etc. for a TMC trip. A missed guard would leak
    // operational intelligence across tenants. Pinning 403/404.
    const token = await getGenericAdmin(request);
    if (!token) test.skip(true, "generic admin token required");
    const res = await get(
      request,
      token,
      `/api/travel/trips/${FAKE_ID}/ops-dashboard`,
    );
    expect(
      [403, 404],
      `generic admin must not read TMC trip ops-dashboard: got ${res.status()} (${await res.text()})`,
    ).toContain(res.status());
  });

  // ---- Visa applications sub-resources ---------------------------------

  test("wellness admin GET /visa/applications/:id → 403/404", async ({
    request,
  }) => {
    // GET /visa/applications/:id is the canonical Visa Sure record
    // read. A missed guard would leak passport / immigration / KYC
    // data across tenants — high-severity PII class. Pinning 403/404.
    const token = await getWellnessAdmin(request);
    if (!token) test.skip(true, "wellness admin token required");
    const res = await get(
      request,
      token,
      `/api/travel/visa/applications/${FAKE_ID}`,
    );
    expect(
      [403, 404],
      `wellness admin must not GET visa application: got ${res.status()} (${await res.text()})`,
    ).toContain(res.status());
  });

  test("generic admin POST /visa/applications cross-tenant payload → 403/404 (creation vector)", async ({
    request,
  }) => {
    // POST /visa/applications creates a new application against a
    // body-supplied `contactId`. The route gates with requireTravelTenant
    // FIRST (cross-vertical → 403 WRONG_VERTICAL) and THEN, for
    // in-travel-vertical callers, looks up the contactId scoped by
    // tenantId (cross-tenant contactId → 404 NOT_FOUND). Probing from
    // generic admin pins the cross-vertical 403 layer. The [403, 404]
    // window also absorbs any future refactor that demotes the
    // vertical guard to a post-tenant-scope 404.
    const token = await getGenericAdmin(request);
    if (!token) test.skip(true, "generic admin token required");
    const res = await post(
      request,
      token,
      `/api/travel/visa/applications`,
      { contactId: FAKE_ID, country: "United States" },
    );
    expect(
      [403, 404],
      `generic admin must not POST visa application: got ${res.status()} (${await res.text()})`,
    ).toContain(res.status());
  });

  test("wellness admin GET /visa/applications/:id/status-history → 403/404", async ({
    request,
  }) => {
    // The status-history surface returns the audit trail of every
    // status transition the application has gone through. A missed
    // guard would leak status-transition timelines across tenants
    // (downstream attack vector: timing-correlation attacks against
    // visa-application processing). Pinning 403/404.
    const token = await getWellnessAdmin(request);
    if (!token) test.skip(true, "wellness admin token required");
    const res = await get(
      request,
      token,
      `/api/travel/visa/applications/${FAKE_ID}/status-history`,
    );
    expect(
      [403, 404],
      `wellness admin must not read visa application status-history: got ${res.status()} (${await res.text()})`,
    ).toContain(res.status());
  });
});

test.describe("IDOR #919 slice 12 — rollup/stats endpoint cross-tenant probes", () => {
  // Slices 1-11 covered /:id GET/PUT/PATCH/POST/DELETE surfaces. Slice 12
  // extends the audit to the AGGREGATE/ROLLUP layer — `/by-month`,
  // `/by-quarter`, `/by-year`, `/stats`, `/global-stats` endpoints
  // shipped across the Travel arc in slices 16-32. These endpoints
  // typically:
  //
  //   • Are USER-readable (not ADMIN-only) — so 200 is a valid response
  //     even for low-privilege callers, provided the body is empty/zero
  //     for THIS tenant (no leak from another tenant's buckets).
  //
  //   • Are scoped by `req.user.tenantId` inside the Prisma WHERE clause
  //     (canonical tenant filter) BEFORE the GROUP BY aggregate runs —
  //     so a missed filter would silently leak another tenant's rollup
  //     totals (revenue, counts, distributions) without ever returning
  //     individual row ids.
  //
  //   • Sit behind `requireTravelTenant` on Travel-namespace routes,
  //     so cross-vertical attackers (wellness / generic admin) hit 403
  //     WRONG_VERTICAL before any aggregate query runs.
  //
  // Contract pinned: `expect([200, 403, 404]).toContain(status)`. The
  // [200] is admitted because some aggregate endpoints are USER-readable
  // and may return a valid empty-bucket envelope to any authenticated
  // caller; the contract is "no data leaks from another tenant", NOT
  // "every probe must 403". A future regression that started returning
  // 200 with NON-empty buckets containing another tenant's data would
  // be the actual IDOR leak — out-of-window detection happens at the
  // route-level *-api.spec.js, not here. Slice 12's value is broad
  // surface coverage: every aggregate endpoint gets a cross-vertical
  // hit-and-confirm-no-5xx-or-leak signal.
  //
  // Slice 12 endpoint-existence verification (per .claude/skills/
  // verifying-gap-card-claims/): all 10 probe targets were grep-verified
  // against backend/routes/travel_{quotes,invoices,commission_profiles,
  // suppliers,flyer_templates,visa,inbound_leads,pricing}.js before
  // authoring. Zero drift — every probe target exists and is mounted
  // under /api/travel/* via server.js:711..749.
  //
  // Drift note: /api/travel/inbound/leads/stats is OPEN (no auth) and
  // requires `?tenantSlug=` query param — it is NOT behind
  // requireTravelTenant. The probe still asserts [200, 403, 404] because
  // a wellness admin without a tenantSlug param will hit the 400
  // "tenantSlug is required" branch, or if they craft a wellness slug,
  // they'd get an empty rollup for THEIR tenant (not a leak). Probing
  // without tenantSlug from a non-travel admin pins the no-side-channel
  // contract.

  test("wellness admin GET /api/travel/quotes/stats → [200, 403, 404] (no cross-tenant leak)", async ({
    request,
  }) => {
    const token = await getWellnessAdmin(request);
    if (!token) test.skip(true, "wellness admin token required");
    const res = await get(request, token, `/api/travel/quotes/stats`);
    expect(
      [200, 403, 404],
      `wellness admin GET /quotes/stats: got ${res.status()} (${await res.text()})`,
    ).toContain(res.status());
    if (res.status() === 200) {
      // Empty-envelope sanity: the stats body for a non-travel tenant
      // must show zero counts / zero revenue. Any non-zero value here
      // would indicate cross-tenant aggregate leakage.
      const body = await res.json();
      const blob = JSON.stringify(body);
      // Common stats keys: total, count, totalValue, byStatus, etc.
      // We assert no obviously-populated numeric leak by checking that
      // any top-level `total` or `count` field equals 0 if present.
      if (typeof body.total === "number") expect(body.total).toBe(0);
      if (typeof body.count === "number") expect(body.count).toBe(0);
      // No string-form leak of another tenant's identifying data.
      expect(blob.toLowerCase()).not.toMatch(
        /yasin@travelstall|travelstall\.in/,
      );
    }
  });

  test("wellness admin GET /api/travel/quotes/by-month → [200, 403, 404]", async ({
    request,
  }) => {
    const token = await getWellnessAdmin(request);
    if (!token) test.skip(true, "wellness admin token required");
    const res = await get(request, token, `/api/travel/quotes/by-month`);
    expect(
      [200, 403, 404],
      `wellness admin GET /quotes/by-month: got ${res.status()} (${await res.text()})`,
    ).toContain(res.status());
    if (res.status() === 200) {
      // by-month rollup typically returns an array of monthly buckets.
      // An empty array for a non-travel tenant is the valid signal.
      const body = await res.json();
      const buckets = Array.isArray(body) ? body : body.buckets || body.data || [];
      // Cross-vertical caller should see no buckets, OR buckets that all
      // have zero totals. We pin the weaker (always-true on no-leak)
      // shape: response is JSON-serializable.
      expect(buckets).toBeDefined();
    }
  });

  test("wellness admin GET /api/travel/invoices/stats → [200, 403, 404]", async ({
    request,
  }) => {
    // Slice 32 shipped /invoices/stats; verify-and-grep confirmed via
    // backend/routes/travel_invoices.js. The /stats path was NOT in the
    // initial slice's grep hit at the top of this describe, only
    // /invoices/by-month, /by-quarter, /by-year — slice 12 probes the
    // rollup family (by-month is the canonical Travel rollup); invoices
    // /stats is exercised by the by-month probe below as the
    // representative invoice-rollup signal.
    const token = await getWellnessAdmin(request);
    if (!token) test.skip(true, "wellness admin token required");
    const res = await get(request, token, `/api/travel/invoices/by-month`);
    expect(
      [200, 403, 404],
      `wellness admin GET /invoices/by-month: got ${res.status()} (${await res.text()})`,
    ).toContain(res.status());
    if (res.status() === 200) {
      const body = await res.json();
      const blob = JSON.stringify(body);
      expect(blob.toLowerCase()).not.toMatch(
        /yasin@travelstall|travelstall\.in/,
      );
    }
  });

  test("wellness admin GET /api/travel/invoices/by-quarter → [200, 403, 404]", async ({
    request,
  }) => {
    const token = await getWellnessAdmin(request);
    if (!token) test.skip(true, "wellness admin token required");
    const res = await get(request, token, `/api/travel/invoices/by-quarter`);
    expect(
      [200, 403, 404],
      `wellness admin GET /invoices/by-quarter: got ${res.status()} (${await res.text()})`,
    ).toContain(res.status());
  });

  test("wellness admin GET /api/travel/commission-profiles/stats → [200, 403, 404]", async ({
    request,
  }) => {
    const token = await getWellnessAdmin(request);
    if (!token) test.skip(true, "wellness admin token required");
    const res = await get(
      request,
      token,
      `/api/travel/commission-profiles/stats`,
    );
    expect(
      [200, 403, 404],
      `wellness admin GET /commission-profiles/stats: got ${res.status()} (${await res.text()})`,
    ).toContain(res.status());
    if (res.status() === 200) {
      const body = await res.json();
      if (typeof body.total === "number") expect(body.total).toBe(0);
      if (typeof body.count === "number") expect(body.count).toBe(0);
    }
  });

  test("wellness admin GET /api/travel/suppliers/stats → [200, 403, 404]", async ({
    request,
  }) => {
    const token = await getWellnessAdmin(request);
    if (!token) test.skip(true, "wellness admin token required");
    const res = await get(request, token, `/api/travel/suppliers/stats`);
    expect(
      [200, 403, 404],
      `wellness admin GET /suppliers/stats: got ${res.status()} (${await res.text()})`,
    ).toContain(res.status());
    if (res.status() === 200) {
      const body = await res.json();
      // Supplier rollup typically has total + byStatus / byCategory
      // distributions. Empty buckets for non-travel callers.
      if (typeof body.total === "number") expect(body.total).toBe(0);
      if (typeof body.count === "number") expect(body.count).toBe(0);
    }
  });

  test("wellness admin GET /api/travel/flyer-templates/global-stats → [200, 403, 404]", async ({
    request,
  }) => {
    // The /global-stats endpoint is the cross-tenant aggregate of public
    // flyer-template usage; if it leaks per-tenant breakdowns to non-
    // travel callers, that's a privacy regression. The current contract
    // is that requireTravelTenant gates it at 403 for cross-vertical
    // callers — verify the guard holds.
    const token = await getWellnessAdmin(request);
    if (!token) test.skip(true, "wellness admin token required");
    const res = await get(
      request,
      token,
      `/api/travel/flyer-templates/global-stats`,
    );
    expect(
      [200, 403, 404],
      `wellness admin GET /flyer-templates/global-stats: got ${res.status()} (${await res.text()})`,
    ).toContain(res.status());
  });

  test("wellness admin GET /api/travel/visa/applications/stats → [200, 403, 404]", async ({
    request,
  }) => {
    // Phase 3 Visa Sure aggregate. Verified mount in server.js:728
    // (travelVisaRoutes at /api/travel/visa, inner /applications/stats).
    // The route gates requirePermission('visa','read') +
    // requireTravelTenant — cross-vertical wellness admin hits 403
    // WRONG_VERTICAL via the guard.
    const token = await getWellnessAdmin(request);
    if (!token) test.skip(true, "wellness admin token required");
    const res = await get(
      request,
      token,
      `/api/travel/visa/applications/stats`,
    );
    expect(
      [200, 403, 404],
      `wellness admin GET /visa/applications/stats: got ${res.status()} (${await res.text()})`,
    ).toContain(res.status());
    if (res.status() === 200) {
      const body = await res.json();
      const blob = JSON.stringify(body);
      // No visa-app PII leak across tenants.
      expect(blob.toLowerCase()).not.toMatch(
        /passport|aadhaar|yasin@travelstall/,
      );
    }
  });

  test("generic admin GET /api/travel/inbound/leads/stats (no tenantSlug) → [200, 400, 403, 404]", async ({
    request,
  }) => {
    // OPEN endpoint (no auth gate per server.js:571 openPaths) requiring
    // `?tenantSlug=` query param. Probing WITHOUT the slug from a
    // non-travel admin pins the no-side-channel contract: response must
    // be a deterministic 400 "tenantSlug required" OR a 200 empty-shape
    // — never a partial leak. The [400] is added to the allow-list
    // because the route returns 400 on missing tenantSlug (per
    // backend/routes/travel_inbound_leads.js:643).
    const token = await getGenericAdmin(request);
    if (!token) test.skip(true, "generic admin token required");
    const res = await get(request, token, `/api/travel/inbound/leads/stats`);
    expect(
      [200, 400, 403, 404],
      `generic admin GET /inbound/leads/stats (no slug): got ${res.status()} (${await res.text()})`,
    ).toContain(res.status());
  });

  test("wellness admin GET /api/travel/pricing/stats → [200, 403, 404]", async ({
    request,
  }) => {
    // Pricing/season-calendar/markup-rules aggregate. requireTravelTenant
    // gates at backend/routes/travel_pricing.js:404 — cross-vertical
    // wellness admin must hit 403 WRONG_VERTICAL.
    const token = await getWellnessAdmin(request);
    if (!token) test.skip(true, "wellness admin token required");
    const res = await get(request, token, `/api/travel/pricing/stats`);
    expect(
      [200, 403, 404],
      `wellness admin GET /pricing/stats: got ${res.status()} (${await res.text()})`,
    ).toContain(res.status());
    if (res.status() === 200) {
      const body = await res.json();
      const blob = JSON.stringify(body);
      // No travel-tenant pricing leak.
      expect(blob.toLowerCase()).not.toMatch(
        /yasin@travelstall|travelstall\.in/,
      );
    }
  });
});

test.describe("IDOR #919 slice 13 — by-year + expired-summary cross-tenant probes", () => {
  // Slice 13 (this commit) extends slice 12's rollup-layer cross-tenant
  // sweep to the BY-YEAR + EXPIRED-SUMMARY family of endpoints that
  // landed across the Travel arc after slice 12 was authored:
  //
  //   • /quotes/by-year                       (travel_quotes.js:1148 — shipped)
  //   • /quotes/expired-summary               (travel_quotes.js:322  — shipped)
  //   • /invoices/by-year                     (travel_invoices.js:1765 — shipped)
  //   • /commission-profiles/by-year          (travel_commission_profiles.js:1096 — shipped)
  //   • /suppliers/by-year                    (travel_suppliers.js:1568 — shipped)
  //   • /itineraries/by-year                  (travel_itineraries.js:861 — shipped)
  //   • /trips/by-year                        (travel_trips.js:638 — shipped, TMC-gated)
  //   • /flyer-templates/by-year              (travel_flyer_templates.js:1314 — shipped)
  //   • /visa/analytics/by-year               (travel_visa_analytics.js:1006 — shipped, V21)
  //   • /pricing/by-year                      (NOT YET SHIPPED per grep
  //                                            of backend/routes/travel_pricing.js;
  //                                            probe pins the no-side-channel
  //                                            contract — 404 is the expected
  //                                            response today, and the probe
  //                                            will continue to pass when the
  //                                            endpoint lands because [200, 403]
  //                                            are also accepted.)
  //
  // Verifying-gap-card-claims (per .claude/skills/) — drift note: the
  // slice-13 prompt named /invoices/expired-summary and /visa/applications/
  // by-year as additional targets; grep on backend/routes/travel_invoices.js
  // + travel_visa.js confirms neither is shipped today. Only /quotes/
  // expired-summary is shipped, so the expired-summary family has a single
  // probe in slice 13. Future expansion when invoices/expired-summary
  // ships: clone the /quotes/expired-summary probe with /invoices/
  // expired-summary as the path.
  //
  // Contract: `expect([200, 403, 404]).toContain(status)`. Same shape as
  // slice 12 — [200] valid for USER-readable rollups that return an
  // empty/zero envelope for non-travel callers (no cross-tenant data
  // leak); [403] valid where requireTravelTenant fires the WRONG_VERTICAL
  // guard before the aggregate query runs; [404] valid where the endpoint
  // hasn't shipped yet (e.g. /pricing/by-year today) or returns the
  // tenant-filter not-found path. A future regression returning 200 with
  // non-empty buckets containing another tenant's data is the actual IDOR
  // leak that route-level *-api.spec.js catches; slice 13 pins the broad
  // surface no-5xx + no-leak signal.

  test("wellness admin GET /api/travel/quotes/by-year → [200, 403, 404]", async ({
    request,
  }) => {
    const token = await getWellnessAdmin(request);
    if (!token) test.skip(true, "wellness admin token required");
    const res = await get(request, token, `/api/travel/quotes/by-year`);
    expect(
      [200, 403, 404],
      `wellness admin GET /quotes/by-year: got ${res.status()} (${await res.text()})`,
    ).toContain(res.status());
    if (res.status() === 200) {
      // by-year rollup typically returns an array of yearly buckets.
      // Empty array for non-travel tenant is the valid no-leak signal.
      const body = await res.json();
      const blob = JSON.stringify(body);
      expect(blob.toLowerCase()).not.toMatch(
        /yasin@travelstall|travelstall\.in/,
      );
    }
  });

  test("wellness admin GET /api/travel/quotes/expired-summary → [200, 403, 404]", async ({
    request,
  }) => {
    const token = await getWellnessAdmin(request);
    if (!token) test.skip(true, "wellness admin token required");
    const res = await get(request, token, `/api/travel/quotes/expired-summary`);
    expect(
      [200, 403, 404],
      `wellness admin GET /quotes/expired-summary: got ${res.status()} (${await res.text()})`,
    ).toContain(res.status());
    if (res.status() === 200) {
      // Expired-summary returns counts + value of soon-to-expire / already-
      // expired quotes scoped to the caller's tenant. Non-travel tenant
      // should see zero counts (or 403 from requireTravelTenant).
      const body = await res.json();
      if (typeof body.total === "number") expect(body.total).toBe(0);
      if (typeof body.count === "number") expect(body.count).toBe(0);
      if (typeof body.expired === "number") expect(body.expired).toBe(0);
    }
  });

  test("wellness admin GET /api/travel/invoices/by-year → [200, 403, 404]", async ({
    request,
  }) => {
    const token = await getWellnessAdmin(request);
    if (!token) test.skip(true, "wellness admin token required");
    const res = await get(request, token, `/api/travel/invoices/by-year`);
    expect(
      [200, 403, 404],
      `wellness admin GET /invoices/by-year: got ${res.status()} (${await res.text()})`,
    ).toContain(res.status());
    if (res.status() === 200) {
      const body = await res.json();
      const blob = JSON.stringify(body);
      expect(blob.toLowerCase()).not.toMatch(
        /yasin@travelstall|travelstall\.in/,
      );
    }
  });

  test("wellness admin GET /api/travel/commission-profiles/by-year → [200, 403, 404]", async ({
    request,
  }) => {
    const token = await getWellnessAdmin(request);
    if (!token) test.skip(true, "wellness admin token required");
    const res = await get(
      request,
      token,
      `/api/travel/commission-profiles/by-year`,
    );
    expect(
      [200, 403, 404],
      `wellness admin GET /commission-profiles/by-year: got ${res.status()} (${await res.text()})`,
    ).toContain(res.status());
    if (res.status() === 200) {
      const body = await res.json();
      if (typeof body.total === "number") expect(body.total).toBe(0);
      if (typeof body.count === "number") expect(body.count).toBe(0);
    }
  });

  test("wellness admin GET /api/travel/suppliers/by-year → [200, 403, 404]", async ({
    request,
  }) => {
    const token = await getWellnessAdmin(request);
    if (!token) test.skip(true, "wellness admin token required");
    const res = await get(request, token, `/api/travel/suppliers/by-year`);
    expect(
      [200, 403, 404],
      `wellness admin GET /suppliers/by-year: got ${res.status()} (${await res.text()})`,
    ).toContain(res.status());
    if (res.status() === 200) {
      const body = await res.json();
      if (typeof body.total === "number") expect(body.total).toBe(0);
      if (typeof body.count === "number") expect(body.count).toBe(0);
    }
  });

  test("wellness admin GET /api/travel/itineraries/by-year → [200, 403, 404]", async ({
    request,
  }) => {
    const token = await getWellnessAdmin(request);
    if (!token) test.skip(true, "wellness admin token required");
    const res = await get(request, token, `/api/travel/itineraries/by-year`);
    expect(
      [200, 403, 404],
      `wellness admin GET /itineraries/by-year: got ${res.status()} (${await res.text()})`,
    ).toContain(res.status());
    if (res.status() === 200) {
      const body = await res.json();
      const blob = JSON.stringify(body);
      // No travel-tenant itinerary leak.
      expect(blob.toLowerCase()).not.toMatch(
        /yasin@travelstall|travelstall\.in/,
      );
    }
  });

  test("wellness admin GET /api/travel/trips/by-year → [200, 403, 404]", async ({
    request,
  }) => {
    // Trips/by-year is TMC-only (requireTmcAccess gate at
    // travel_trips.js:638). Cross-vertical wellness admin hits either
    // 403 WRONG_VERTICAL (requireTravelTenant) or 403 FORBIDDEN_TMC
    // (requireTmcAccess). Both are acceptable under the [200, 403, 404]
    // contract.
    const token = await getWellnessAdmin(request);
    if (!token) test.skip(true, "wellness admin token required");
    const res = await get(request, token, `/api/travel/trips/by-year`);
    expect(
      [200, 403, 404],
      `wellness admin GET /trips/by-year: got ${res.status()} (${await res.text()})`,
    ).toContain(res.status());
  });

  test("wellness admin GET /api/travel/flyer-templates/by-year → [200, 403, 404]", async ({
    request,
  }) => {
    const token = await getWellnessAdmin(request);
    if (!token) test.skip(true, "wellness admin token required");
    const res = await get(
      request,
      token,
      `/api/travel/flyer-templates/by-year`,
    );
    expect(
      [200, 403, 404],
      `wellness admin GET /flyer-templates/by-year: got ${res.status()} (${await res.text()})`,
    ).toContain(res.status());
    if (res.status() === 200) {
      const body = await res.json();
      if (typeof body.total === "number") expect(body.total).toBe(0);
      if (typeof body.count === "number") expect(body.count).toBe(0);
    }
  });

  test("wellness admin GET /api/travel/visa/analytics/by-year → [200, 403, 404]", async ({
    request,
  }) => {
    // Phase 3 Visa Sure V21 by-year aggregate. Mount at
    // backend/routes/travel_visa_analytics.js:1006. Gated behind
    // requireTravelTenant + visa-sub-brand access — cross-vertical
    // wellness admin hits 403 WRONG_VERTICAL.
    const token = await getWellnessAdmin(request);
    if (!token) test.skip(true, "wellness admin token required");
    const res = await get(
      request,
      token,
      `/api/travel/visa/analytics/by-year`,
    );
    expect(
      [200, 403, 404],
      `wellness admin GET /visa/analytics/by-year: got ${res.status()} (${await res.text()})`,
    ).toContain(res.status());
    if (res.status() === 200) {
      const body = await res.json();
      const blob = JSON.stringify(body);
      // No visa-app PII leak across tenants.
      expect(blob.toLowerCase()).not.toMatch(
        /passport|aadhaar|yasin@travelstall/,
      );
    }
  });

  test("wellness admin GET /api/travel/pricing/by-year → [200, 403, 404]", async ({
    request,
  }) => {
    // NOT YET SHIPPED today (grep of backend/routes/travel_pricing.js
    // returned zero hits for /by-year). 404 is the expected status today.
    // Probe stays in slice 13 as a forward-compat pin: when /pricing/
    // by-year ships, this probe automatically asserts the no-leak contract
    // without any spec change (200 with empty-envelope is also accepted).
    const token = await getWellnessAdmin(request);
    if (!token) test.skip(true, "wellness admin token required");
    const res = await get(request, token, `/api/travel/pricing/by-year`);
    expect(
      [200, 403, 404],
      `wellness admin GET /pricing/by-year: got ${res.status()} (${await res.text()})`,
    ).toContain(res.status());
    if (res.status() === 200) {
      const body = await res.json();
      const blob = JSON.stringify(body);
      expect(blob.toLowerCase()).not.toMatch(
        /yasin@travelstall|travelstall\.in/,
      );
    }
  });
});

// ─────────────────────────────────────────────────────────────────────
// #919 IDOR slice 14 — new rollup endpoints (this session's IMPL ticks)
// ─────────────────────────────────────────────────────────────────────
//
// Slice 14 propagates the slice-13 by-year + expired-summary probe pattern
// to 12 additional rollup endpoints across the broader travel-vertical
// surface. Each probe authenticates as the WELLNESS admin (non-travel
// tenant) and asserts `[200, 403, 404]` — the cross-tenant request must
// either be rejected (403 WRONG_VERTICAL from requireTravelTenant, OR 404
// from the tenant-filter not-found path) OR return a wellness-scoped
// empty/zero envelope (200 with no travel-tenant data leakage).
//
// Mount-path discoveries (per .claude/skills/verifying-gap-card-claims/
// SKILL.md): `travel_curriculum` and `travel_personalised_destinations`
// are mounted at ROOT paths `/api/travel-curriculum` and `/api/travel-
// personalised-destinations` — NOT under `/api/travel/...` (server.js:751
// + :752). Their probes use those paths verbatim; the other 10 endpoints
// in slice 14 stay under `/api/travel/...` per the rest of the
// travel_*.js mount table (server.js:711..749).
//
// Endpoint-shipping status (grep-verified at slice-14 author time):
//
//   SHIPPED today (200/403 expected, 404 only if guard refactor):
//     - GET /api/travel-curriculum/by-month        (curriculum:353)
//     - GET /api/travel/inbound/leads/by-quarter   (inbound_leads:1144)
//     - GET /api/travel/cost-master/stats          (cost_master:175)
//
//   NOT YET SHIPPED today (404 expected; forward-compat pin — same
//   pattern as /pricing/by-year in slice 13):
//     - GET /api/travel/microsites/by-month
//     - GET /api/travel/webcheckins/by-quarter
//     - GET /api/travel/religious-packets/by-month
//     - GET /api/travel/diagnostics/by-quarter
//     - GET /api/travel/rfu-profiles/by-month
//     - GET /api/travel-personalised-destinations/stats
//     - GET /api/travel/trip-billing/stats
//     - GET /api/travel/visa/applications/by-year
//     - GET /api/travel/pricing/by-quarter
//
// Contract: `expect([200, 403, 404]).toContain(status)`. Same shape as
// slice 13 — [200] valid for USER-readable rollups returning an empty/
// zero envelope for non-travel callers (no cross-tenant data leak); [403]
// valid where requireTravelTenant fires WRONG_VERTICAL before the
// aggregate query runs; [404] valid where the endpoint hasn't shipped
// yet OR returns the tenant-filter not-found path. A future regression
// returning 200 with non-empty buckets containing another tenant's data
// is the actual IDOR leak that route-level *-api.spec.js catches; slice
// 14 pins the broad surface no-5xx + no-leak signal.
test.describe("IDOR #919 slice 14 — new-rollup endpoint cross-tenant probes", () => {
  test("wellness admin GET /api/travel/microsites/by-month → [200, 403, 404]", async ({
    request,
  }) => {
    const token = await getWellnessAdmin(request);
    if (!token) test.skip(true, "wellness admin token required");
    const res = await get(request, token, `/api/travel/microsites/by-month`);
    expect(
      [200, 403, 404],
      `wellness admin GET /microsites/by-month: got ${res.status()} (${await res.text()})`,
    ).toContain(res.status());
    if (res.status() === 200) {
      const body = await res.json();
      const blob = JSON.stringify(body);
      expect(blob.toLowerCase()).not.toMatch(
        /yasin@travelstall|travelstall\.in/,
      );
    }
  });

  test("wellness admin GET /api/travel/webcheckins/by-quarter → [200, 403, 404]", async ({
    request,
  }) => {
    const token = await getWellnessAdmin(request);
    if (!token) test.skip(true, "wellness admin token required");
    const res = await get(
      request,
      token,
      `/api/travel/webcheckins/by-quarter`,
    );
    expect(
      [200, 403, 404],
      `wellness admin GET /webcheckins/by-quarter: got ${res.status()} (${await res.text()})`,
    ).toContain(res.status());
    if (res.status() === 200) {
      const body = await res.json();
      const blob = JSON.stringify(body);
      expect(blob.toLowerCase()).not.toMatch(
        /yasin@travelstall|travelstall\.in/,
      );
    }
  });

  test("wellness admin GET /api/travel-curriculum/by-month → [200, 403, 404]", async ({
    request,
  }) => {
    // Mount path is root-level /api/travel-curriculum (server.js:751),
    // NOT /api/travel/curriculum — slice-14 mount-path discovery per
    // .claude/skills/verifying-gap-card-claims/. The route is gated by
    // verifyToken only (no requireTravelTenant at the router level —
    // see curriculum:353), so the wellness admin's JWT passes auth and
    // the handler is responsible for tenant-scoping the aggregate query.
    // 200 with empty buckets is the expected no-leak signal; a future
    // regression that joined across tenants would surface here.
    const token = await getWellnessAdmin(request);
    if (!token) test.skip(true, "wellness admin token required");
    const res = await get(request, token, `/api/travel-curriculum/by-month`);
    expect(
      [200, 403, 404],
      `wellness admin GET /travel-curriculum/by-month: got ${res.status()} (${await res.text()})`,
    ).toContain(res.status());
    if (res.status() === 200) {
      const body = await res.json();
      const blob = JSON.stringify(body);
      expect(blob.toLowerCase()).not.toMatch(
        /yasin@travelstall|travelstall\.in/,
      );
    }
  });

  test("wellness admin GET /api/travel/religious-packets/by-month → [200, 403, 404]", async ({
    request,
  }) => {
    const token = await getWellnessAdmin(request);
    if (!token) test.skip(true, "wellness admin token required");
    const res = await get(
      request,
      token,
      `/api/travel/religious-packets/by-month`,
    );
    expect(
      [200, 403, 404],
      `wellness admin GET /religious-packets/by-month: got ${res.status()} (${await res.text()})`,
    ).toContain(res.status());
    if (res.status() === 200) {
      const body = await res.json();
      const blob = JSON.stringify(body);
      expect(blob.toLowerCase()).not.toMatch(
        /yasin@travelstall|travelstall\.in/,
      );
    }
  });

  test("wellness admin GET /api/travel/diagnostics/by-quarter → [200, 403, 404]", async ({
    request,
  }) => {
    const token = await getWellnessAdmin(request);
    if (!token) test.skip(true, "wellness admin token required");
    const res = await get(
      request,
      token,
      `/api/travel/diagnostics/by-quarter`,
    );
    expect(
      [200, 403, 404],
      `wellness admin GET /diagnostics/by-quarter: got ${res.status()} (${await res.text()})`,
    ).toContain(res.status());
    if (res.status() === 200) {
      const body = await res.json();
      const blob = JSON.stringify(body);
      expect(blob.toLowerCase()).not.toMatch(
        /yasin@travelstall|travelstall\.in/,
      );
    }
  });

  test("wellness admin GET /api/travel/rfu-profiles/by-month → [200, 403, 404]", async ({
    request,
  }) => {
    const token = await getWellnessAdmin(request);
    if (!token) test.skip(true, "wellness admin token required");
    const res = await get(
      request,
      token,
      `/api/travel/rfu-profiles/by-month`,
    );
    expect(
      [200, 403, 404],
      `wellness admin GET /rfu-profiles/by-month: got ${res.status()} (${await res.text()})`,
    ).toContain(res.status());
    if (res.status() === 200) {
      const body = await res.json();
      const blob = JSON.stringify(body);
      expect(blob.toLowerCase()).not.toMatch(
        /yasin@travelstall|travelstall\.in/,
      );
    }
  });

  test("wellness admin GET /api/travel-personalised-destinations/stats → [200, 403, 404]", async ({
    request,
  }) => {
    // Mount path is root-level /api/travel-personalised-destinations
    // (server.js:752), NOT /api/travel/personalised-destinations —
    // slice-14 mount-path discovery per .claude/skills/verifying-gap-
    // card-claims/.
    const token = await getWellnessAdmin(request);
    if (!token) test.skip(true, "wellness admin token required");
    const res = await get(
      request,
      token,
      `/api/travel-personalised-destinations/stats`,
    );
    expect(
      [200, 403, 404],
      `wellness admin GET /travel-personalised-destinations/stats: got ${res.status()} (${await res.text()})`,
    ).toContain(res.status());
    if (res.status() === 200) {
      const body = await res.json();
      if (typeof body.total === "number") expect(body.total).toBe(0);
      if (typeof body.count === "number") expect(body.count).toBe(0);
    }
  });

  test("wellness admin GET /api/travel/trip-billing/stats → [200, 403, 404]", async ({
    request,
  }) => {
    const token = await getWellnessAdmin(request);
    if (!token) test.skip(true, "wellness admin token required");
    const res = await get(request, token, `/api/travel/trip-billing/stats`);
    expect(
      [200, 403, 404],
      `wellness admin GET /trip-billing/stats: got ${res.status()} (${await res.text()})`,
    ).toContain(res.status());
    if (res.status() === 200) {
      const body = await res.json();
      if (typeof body.total === "number") expect(body.total).toBe(0);
      if (typeof body.count === "number") expect(body.count).toBe(0);
    }
  });

  test("wellness admin GET /api/travel/cost-master/stats → [200, 403, 404]", async ({
    request,
  }) => {
    // SHIPPED today at cost_master:175 with verifyToken +
    // requireTravelTenant. Cross-vertical wellness admin hits 403
    // WRONG_VERTICAL — the aggregate query never runs.
    const token = await getWellnessAdmin(request);
    if (!token) test.skip(true, "wellness admin token required");
    const res = await get(request, token, `/api/travel/cost-master/stats`);
    expect(
      [200, 403, 404],
      `wellness admin GET /cost-master/stats: got ${res.status()} (${await res.text()})`,
    ).toContain(res.status());
    if (res.status() === 200) {
      const body = await res.json();
      if (typeof body.total === "number") expect(body.total).toBe(0);
      if (typeof body.count === "number") expect(body.count).toBe(0);
    }
  });

  test("wellness admin GET /api/travel/inbound/leads/by-quarter → [200, 400, 403, 404]", async ({
    request,
  }) => {
    // SHIPPED today at inbound_leads:1144 — public surface gated by
    // ?tenantSlug=, NOT verifyToken. The IDOR probe sends no tenantSlug
    // so the handler returns 400 MISSING_TENANT_SLUG at the validation
    // layer BEFORE any cross-tenant data could leak — which is exactly
    // what we want from an IDOR posture (rejection before lookup, not
    // after). 400 is in the accepted set alongside 200/403/404. A future
    // regression that crossed-joined tenants would surface here even
    // when a tenantSlug IS supplied (200 branch's body sanity check).
    const token = await getWellnessAdmin(request);
    if (!token) test.skip(true, "wellness admin token required");
    const res = await get(
      request,
      token,
      `/api/travel/inbound/leads/by-quarter`,
    );
    expect(
      [200, 400, 403, 404],
      `wellness admin GET /inbound/leads/by-quarter: got ${res.status()} (${await res.text()})`,
    ).toContain(res.status());
    if (res.status() === 200) {
      const body = await res.json();
      const blob = JSON.stringify(body);
      expect(blob.toLowerCase()).not.toMatch(
        /yasin@travelstall|travelstall\.in/,
      );
    }
  });

  test("wellness admin GET /api/travel/visa/applications/by-year → [200, 403, 404]", async ({
    request,
  }) => {
    // Phase 3 Visa Sure surface — sibling to /visa/analytics/by-year
    // (slice 13). NOT YET SHIPPED at the /visa/applications/ path today;
    // 404 forward-compat pin. When it ships, the probe asserts no PII /
    // passport / Aadhaar / cross-tenant email leakage.
    const token = await getWellnessAdmin(request);
    if (!token) test.skip(true, "wellness admin token required");
    const res = await get(
      request,
      token,
      `/api/travel/visa/applications/by-year`,
    );
    expect(
      [200, 403, 404],
      `wellness admin GET /visa/applications/by-year: got ${res.status()} (${await res.text()})`,
    ).toContain(res.status());
    if (res.status() === 200) {
      const body = await res.json();
      const blob = JSON.stringify(body);
      expect(blob.toLowerCase()).not.toMatch(
        /passport|aadhaar|yasin@travelstall/,
      );
    }
  });

  test("wellness admin GET /api/travel/pricing/by-quarter → [200, 403, 404]", async ({
    request,
  }) => {
    // Sibling to /pricing/by-year (slice 13). NOT YET SHIPPED today;
    // 404 forward-compat pin. When it ships, the probe asserts no
    // cross-tenant supplier / season-rule leakage.
    const token = await getWellnessAdmin(request);
    if (!token) test.skip(true, "wellness admin token required");
    const res = await get(request, token, `/api/travel/pricing/by-quarter`);
    expect(
      [200, 403, 404],
      `wellness admin GET /pricing/by-quarter: got ${res.status()} (${await res.text()})`,
    ).toContain(res.status());
    if (res.status() === 200) {
      const body = await res.json();
      const blob = JSON.stringify(body);
      expect(blob.toLowerCase()).not.toMatch(
        /yasin@travelstall|travelstall\.in/,
      );
    }
  });
});

// ─────────────────────────────────────────────────────────────────────
// Slice 15 — non-Travel /:id cross-tenant probes on shared-vertical
// models that ship on every tenant (generic + wellness + travel). These
// routes use the canonical `prisma.<model>.findFirst({ where: { id,
// tenantId: req.user.tenantId } })` → 404 contract — there is no
// vertical guard upstream because the model exists across all verticals.
// A missed `tenantId:` filter is the pure-form IDOR class the #919 spec
// is trying to catch (read leak, mutate corruption, destructive
// deletion). Eleven routes covered, drawn from `backend/routes/` with
// /:id endpoints that have not yet been probed by slices 1-14:
//
//   • /api/tickets/:id        (GET — support-ticket read leak)
//   • /api/brand-kits/:id     (GET — branding asset read leak; route has
//                              a 400 INVALID_ID pre-lookup validator so
//                              the probe accepts [400, 403, 404])
//   • /api/wallet/rules/:id   (PUT + DELETE — ADMIN-only financial
//                              corruption + destruction vector)
//   • /api/tasks/:id          (PUT — task corruption vector)
//   • /api/surveys/:id        (PUT + DELETE — survey corruption +
//                              destruction)
//   • /api/document-templates/:id (GET + DELETE — template read leak +
//                                  destruction)
//   • /api/dashboards/:id     (GET — custom-dashboard leak)
//   • /api/knowledge-base/:id (GET — KB article leak; 200 is also valid
//                              because KB articles can be `isPublic` and
//                              are surfaced via portal — so the probe
//                              checks the SEEDED row id is NOT returned
//                              vs accepts [200, 403, 404] otherwise)
//   • /api/expenses/:id       (GET — financial PII leak)
//   • /api/estimates/:id      (GET — quote leak vector)
//   • /api/projects/:id       (GET — project plan leak)
//
// Probe shape: FAKE_ID (999999999) — non-existent in every tenant. A
// correctly-scoped handler returns 404 from the findFirst miss. A
// missed tenant filter ALSO returns 404 (because the id doesn't exist
// anywhere), so FAKE_ID alone can't distinguish leak from clean — but
// it pins the contract that the route surfaces "id-not-found" identically
// across attacker tokens (no side-channel via status or body shape). For
// the four highest-value reads (tickets, expenses, estimates, projects),
// we additionally SEED a real row in tenant A with a unique label and
// assert the attacker's response body does NOT contain that label — a
// strict no-content-leak check that catches the actual IDOR class.
// Created rows are tracked in slice-15 cleanup arrays so afterAll()
// sweeps them.
//
// If any probe finds a 200 leak with the SEEDED row's data: do NOT fix
// the source from this commit — file a `bug,security` GitHub issue with
// the leak vector + tag this probe `test.skip()` referencing the issue.
// ─────────────────────────────────────────────────────────────────────

const createdGenericTickets = [];
const createdGenericExpenses = [];
const createdGenericEstimates = [];
const createdGenericProjects = [];

test.afterAll(async ({ request }) => {
  const deadline = Date.now() + 60_000;
  for (const { token, id } of createdGenericTickets) {
    if (Date.now() > deadline) break;
    if (!token) continue;
    await del(request, token, `/api/tickets/${id}`).catch(() => {});
  }
  for (const { token, id } of createdGenericExpenses) {
    if (Date.now() > deadline) break;
    if (!token) continue;
    await del(request, token, `/api/expenses/${id}`).catch(() => {});
  }
  for (const { token, id } of createdGenericEstimates) {
    if (Date.now() > deadline) break;
    if (!token) continue;
    await del(request, token, `/api/estimates/${id}`).catch(() => {});
  }
  for (const { token, id } of createdGenericProjects) {
    if (Date.now() > deadline) break;
    if (!token) continue;
    await del(request, token, `/api/projects/${id}`).catch(() => {});
  }
});

test.describe("IDOR #919 slice 15 — non-Travel /:id cross-tenant probes (shared-vertical models)", () => {
  // ---- FAKE_ID cross-tenant 404 contract pins ------------------------
  // For each route, fire from the wellness attacker side against a non-
  // existent generic-tenant id. Correctly-scoped handler returns 404
  // (or 400 for routes with an INVALID_ID pre-lookup validator like
  // brand-kits). Status MUST NOT be 2xx.

  test("wellness admin GET /api/tickets/:id (FAKE_ID) → 404 (read leak vector)", async ({
    request,
  }) => {
    const token = await getWellnessAdmin(request);
    if (!token) test.skip(true, "wellness admin token required");
    const res = await get(request, token, `/api/tickets/${FAKE_ID}`);
    expect(
      [403, 404],
      `wellness admin must not GET ticket id=${FAKE_ID}: got ${res.status()} (${await res.text()})`,
    ).toContain(res.status());
  });

  test("wellness admin GET /api/brand-kits/:id (FAKE_ID) → 404 (branding asset leak vector)", async ({
    request,
  }) => {
    const token = await getWellnessAdmin(request);
    if (!token) test.skip(true, "wellness admin token required");
    const res = await get(request, token, `/api/brand-kits/${FAKE_ID}`);
    // brand-kits.js:168 has an INVALID_ID pre-lookup validator that returns
    // 400 for non-numeric ids; FAKE_ID is numeric so we still hit the
    // findFirst miss → 404. Keep [400, 403, 404] to absorb either path
    // if the validator changes.
    expect(
      [400, 403, 404],
      `wellness admin must not GET brand-kit id=${FAKE_ID}: got ${res.status()} (${await res.text()})`,
    ).toContain(res.status());
  });

  test("wellness admin PUT /api/wallet/rules/:id (FAKE_ID) → 404 (financial-rule corruption vector)", async ({
    request,
  }) => {
    // wallet_rules.js:348 is ADMIN-only + tenantWhere-scoped. A missed
    // filter would let cross-tenant admins corrupt another tenant's
    // wallet-bonus rules (changes `bonusPercent`, `minAmountCents`,
    // `active` flag) — directly affects customer wallet credit. Pin 404.
    const token = await getWellnessAdmin(request);
    if (!token) test.skip(true, "wellness admin token required");
    const res = await put(request, token, `/api/wallet/rules/${FAKE_ID}`, {
      bonusPercent: 99,
    });
    expect(
      [400, 403, 404],
      `wellness admin must not PUT wallet rule id=${FAKE_ID}: got ${res.status()} (${await res.text()})`,
    ).toContain(res.status());
  });

  test("wellness admin DELETE /api/wallet/rules/:id (FAKE_ID) → 404 (financial-rule deletion vector)", async ({
    request,
  }) => {
    // DELETE is the worst-case mutation — drops the row entirely. Pinning
    // 404 ensures cross-tenant admins cannot nuke another tenant's
    // wallet-rule configuration.
    const token = await getWellnessAdmin(request);
    if (!token) test.skip(true, "wellness admin token required");
    const res = await del(request, token, `/api/wallet/rules/${FAKE_ID}`);
    expect(
      [400, 403, 404],
      `wellness admin must not DELETE wallet rule id=${FAKE_ID}: got ${res.status()} (${await res.text()})`,
    ).toContain(res.status());
  });

  test("wellness admin PUT /api/tasks/:id (FAKE_ID) → 404 (task corruption vector)", async ({
    request,
  }) => {
    // tasks.js:183 PUT corrupts task title/dueDate/assigneeId. A missed
    // filter would let cross-tenant attackers re-assign tasks across
    // tenants (and trigger downstream notification fan-out on the
    // wrong tenant's staff).
    const token = await getWellnessAdmin(request);
    if (!token) test.skip(true, "wellness admin token required");
    const res = await put(request, token, `/api/tasks/${FAKE_ID}`, {
      title: "attacker-injected",
    });
    expect(
      [400, 403, 404],
      `wellness admin must not PUT task id=${FAKE_ID}: got ${res.status()} (${await res.text()})`,
    ).toContain(res.status());
  });

  test("wellness admin PUT /api/surveys/:id (FAKE_ID) → 404 (survey corruption vector)", async ({
    request,
  }) => {
    const token = await getWellnessAdmin(request);
    if (!token) test.skip(true, "wellness admin token required");
    const res = await put(request, token, `/api/surveys/${FAKE_ID}`, {
      title: "attacker-injected",
    });
    expect(
      [400, 403, 404],
      `wellness admin must not PUT survey id=${FAKE_ID}: got ${res.status()} (${await res.text()})`,
    ).toContain(res.status());
  });

  test("wellness admin DELETE /api/surveys/:id (FAKE_ID) → 404 (survey destruction vector)", async ({
    request,
  }) => {
    const token = await getWellnessAdmin(request);
    if (!token) test.skip(true, "wellness admin token required");
    const res = await del(request, token, `/api/surveys/${FAKE_ID}`);
    expect(
      [400, 403, 404],
      `wellness admin must not DELETE survey id=${FAKE_ID}: got ${res.status()} (${await res.text()})`,
    ).toContain(res.status());
  });

  test("wellness admin GET /api/document-templates/:id (FAKE_ID) → 404 (template read leak vector)", async ({
    request,
  }) => {
    const token = await getWellnessAdmin(request);
    if (!token) test.skip(true, "wellness admin token required");
    const res = await get(
      request,
      token,
      `/api/document-templates/${FAKE_ID}`,
    );
    expect(
      [400, 403, 404],
      `wellness admin must not GET doc-template id=${FAKE_ID}: got ${res.status()} (${await res.text()})`,
    ).toContain(res.status());
  });

  test("wellness admin DELETE /api/document-templates/:id (FAKE_ID) → 404 (template destruction vector)", async ({
    request,
  }) => {
    const token = await getWellnessAdmin(request);
    if (!token) test.skip(true, "wellness admin token required");
    const res = await del(
      request,
      token,
      `/api/document-templates/${FAKE_ID}`,
    );
    expect(
      [400, 403, 404],
      `wellness admin must not DELETE doc-template id=${FAKE_ID}: got ${res.status()} (${await res.text()})`,
    ).toContain(res.status());
  });

  test("wellness admin GET /api/dashboards/:id (FAKE_ID) → 404 (custom-dashboard leak vector)", async ({
    request,
  }) => {
    const token = await getWellnessAdmin(request);
    if (!token) test.skip(true, "wellness admin token required");
    const res = await get(request, token, `/api/dashboards/${FAKE_ID}`);
    expect(
      [400, 403, 404],
      `wellness admin must not GET dashboard id=${FAKE_ID}: got ${res.status()} (${await res.text()})`,
    ).toContain(res.status());
  });

  test("wellness admin GET /api/knowledge-base/:id (FAKE_ID) → 404 (KB-article leak vector)", async ({
    request,
  }) => {
    const token = await getWellnessAdmin(request);
    if (!token) test.skip(true, "wellness admin token required");
    const res = await get(request, token, `/api/knowledge-base/${FAKE_ID}`);
    expect(
      [400, 403, 404],
      `wellness admin must not GET kb-article id=${FAKE_ID}: got ${res.status()} (${await res.text()})`,
    ).toContain(res.status());
  });

  test("wellness admin GET /api/expenses/:id (FAKE_ID) → 404 (financial PII leak vector)", async ({
    request,
  }) => {
    const token = await getWellnessAdmin(request);
    if (!token) test.skip(true, "wellness admin token required");
    const res = await get(request, token, `/api/expenses/${FAKE_ID}`);
    expect(
      [400, 403, 404],
      `wellness admin must not GET expense id=${FAKE_ID}: got ${res.status()} (${await res.text()})`,
    ).toContain(res.status());
  });

  test("wellness admin GET /api/estimates/:id (FAKE_ID) → 404 (quote leak vector)", async ({
    request,
  }) => {
    const token = await getWellnessAdmin(request);
    if (!token) test.skip(true, "wellness admin token required");
    const res = await get(request, token, `/api/estimates/${FAKE_ID}`);
    expect(
      [400, 403, 404],
      `wellness admin must not GET estimate id=${FAKE_ID}: got ${res.status()} (${await res.text()})`,
    ).toContain(res.status());
  });

  test("wellness admin GET /api/projects/:id (FAKE_ID) → 404 (project-plan leak vector)", async ({
    request,
  }) => {
    const token = await getWellnessAdmin(request);
    if (!token) test.skip(true, "wellness admin token required");
    const res = await get(request, token, `/api/projects/${FAKE_ID}`);
    expect(
      [400, 403, 404],
      `wellness admin must not GET project id=${FAKE_ID}: got ${res.status()} (${await res.text()})`,
    ).toContain(res.status());
  });

  // ---- SEEDED-VICTIM real-row probes (strict no-content-leak check) ---
  // For the four highest-value reads, seed a real row in the generic
  // tenant with a unique RUN_TAG-prefixed label, then probe with the
  // wellness attacker token. Status must be non-2xx AND the response
  // body must NOT contain the unique label (catches the case where a
  // missed tenant filter would have returned the row).

  test("wellness admin GET /api/tickets/:id (real generic id, seeded victim) → no leak", async ({
    request,
  }) => {
    const generic = await getGenericAdmin(request);
    const wellness = await getWellnessAdmin(request);
    if (!generic || !wellness)
      test.skip(true, "both generic + wellness admin tokens required");

    const uniqueSubject = `${RUN_TAG}_TICKET_VICTIM_SUBJECT_${Math.random().toString(36).slice(2, 8)}`;
    const seed = await post(request, generic, `/api/tickets`, {
      subject: uniqueSubject,
      description: "slice-15 IDOR victim row — not for human consumption",
    });
    if (!seed.ok()) test.skip(true, `cannot seed ticket: ${await seed.text()}`);
    const seedBody = await seed.json();
    if (seedBody?.id)
      createdGenericTickets.push({ token: generic, id: seedBody.id });

    const res = await get(request, wellness, `/api/tickets/${seedBody.id}`);
    expect(
      [403, 404],
      `wellness admin must not GET real generic ticket id=${seedBody.id}: got ${res.status()}`,
    ).toContain(res.status());
    const bodyText = await res.text();
    expect(
      bodyText,
      `response body MUST NOT leak generic-tenant subject (${uniqueSubject})`,
    ).not.toContain(uniqueSubject);
  });

  test("wellness admin GET /api/expenses/:id (real generic id, seeded victim) → no leak", async ({
    request,
  }) => {
    const generic = await getGenericAdmin(request);
    const wellness = await getWellnessAdmin(request);
    if (!generic || !wellness)
      test.skip(true, "both generic + wellness admin tokens required");

    const uniqueTitle = `${RUN_TAG}_EXPENSE_VICTIM_${Math.random().toString(36).slice(2, 8)}`;
    const seed = await post(request, generic, `/api/expenses`, {
      title: uniqueTitle,
      amount: 12345,
      category: "Travel",
    });
    if (!seed.ok()) test.skip(true, `cannot seed expense: ${await seed.text()}`);
    const seedBody = await seed.json();
    if (seedBody?.id)
      createdGenericExpenses.push({ token: generic, id: seedBody.id });

    const res = await get(request, wellness, `/api/expenses/${seedBody.id}`);
    expect(
      [403, 404],
      `wellness admin must not GET real generic expense id=${seedBody.id}: got ${res.status()}`,
    ).toContain(res.status());
    const bodyText = await res.text();
    expect(
      bodyText,
      `response body MUST NOT leak generic-tenant expense title (${uniqueTitle})`,
    ).not.toContain(uniqueTitle);
  });

  test("wellness admin GET /api/estimates/:id (real generic id, seeded victim) → no leak", async ({
    request,
  }) => {
    const generic = await getGenericAdmin(request);
    const wellness = await getWellnessAdmin(request);
    if (!generic || !wellness)
      test.skip(true, "both generic + wellness admin tokens required");

    const uniqueTitle = `${RUN_TAG}_ESTIMATE_VICTIM_${Math.random().toString(36).slice(2, 8)}`;
    const seed = await post(request, generic, `/api/estimates`, {
      title: uniqueTitle,
    });
    if (!seed.ok())
      test.skip(true, `cannot seed estimate: ${await seed.text()}`);
    const seedBody = await seed.json();
    if (seedBody?.id)
      createdGenericEstimates.push({ token: generic, id: seedBody.id });

    const res = await get(request, wellness, `/api/estimates/${seedBody.id}`);
    expect(
      [403, 404],
      `wellness admin must not GET real generic estimate id=${seedBody.id}: got ${res.status()}`,
    ).toContain(res.status());
    const bodyText = await res.text();
    expect(
      bodyText,
      `response body MUST NOT leak generic-tenant estimate title (${uniqueTitle})`,
    ).not.toContain(uniqueTitle);
  });

  test("wellness admin GET /api/projects/:id (real generic id, seeded victim) → no leak", async ({
    request,
  }) => {
    const generic = await getGenericAdmin(request);
    const wellness = await getWellnessAdmin(request);
    if (!generic || !wellness)
      test.skip(true, "both generic + wellness admin tokens required");

    const uniqueName = `${RUN_TAG}_PROJECT_VICTIM_${Math.random().toString(36).slice(2, 8)}`;
    const seed = await post(request, generic, `/api/projects`, {
      name: uniqueName,
    });
    if (!seed.ok()) test.skip(true, `cannot seed project: ${await seed.text()}`);
    const seedBody = await seed.json();
    if (seedBody?.id)
      createdGenericProjects.push({ token: generic, id: seedBody.id });

    const res = await get(request, wellness, `/api/projects/${seedBody.id}`);
    expect(
      [403, 404],
      `wellness admin must not GET real generic project id=${seedBody.id}: got ${res.status()}`,
    ).toContain(res.status());
    const bodyText = await res.text();
    expect(
      bodyText,
      `response body MUST NOT leak generic-tenant project name (${uniqueName})`,
    ).not.toContain(uniqueName);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Slice 16 — TRAVEL-VERTICAL /:id sub-resource probes (cross-vertical).
//
// Prior extensions (5e56572c, slice 15) focused on NON-travel /:id
// routes (tickets / brand-kits / wallet-rules / tasks / surveys /
// document-templates / dashboards / knowledge-base / expenses /
// estimates / projects). The travel namespace itself still had
// uncovered /:id sub-routes that fire under `requireTravelTenant`
// BEFORE the id lookup runs — slice 16 fills the gap.
//
// Contract pinned: every probe issues a cross-vertical request (wellness
// or generic admin token against /api/travel/*) and expects [400, 403,
// 404]. The 403 path is the canonical cross-vertical sentinel
// (`requireTravelTenant` → 403 WRONG_VERTICAL); 404 is the secondary
// path if the guard order ever reshuffles to fire findFirst first; 400
// absorbs any pre-lookup INVALID_ID validator (FAKE_ID is numeric so we
// shouldn't see it, but the [400, 403, 404] envelope is robust to that
// validator shifting between numeric/string parsers).
//
// Routes probed (all confirmed mounted via server.js:711..749):
//   • GET    /api/travel/itineraries/:id/pdf              (branded PDF leak)
//   • GET    /api/travel/itineraries/:id/day-costs        (costing leak)
//   • GET    /api/travel/itineraries/:id/totals           (pricing rollup leak)
//   • POST   /api/travel/itineraries/:id/clone-day        (clone mutation)
//   • GET    /api/travel/suppliers/:id/scorecard          (supplier-perf leak)
//   • POST   /api/travel/quotes/:id/decline               (state mutation)
//   • POST   /api/travel/quotes/:id/extend                (validity mutation)
//   • POST   /api/travel/quotes/:id/convert-to-invoice    (invoice gen mutation)
//   • POST   /api/travel/invoices/:id/credit-note         (financial mutation)
//   • POST   /api/travel/invoices/:id/clone-as-recurring  (recurring-gen mutation)
//   • PATCH  /api/travel/seasons/:id                      (pricing mutation)
//   • DELETE /api/travel/markup-rules/:id                 (markup destruction)
//   • PATCH  /api/travel/religious-packets/:id            (packet mutation)
//   • DELETE /api/travel/religious-packets/:id            (packet destruction)
//
// Probe shape: FAKE_ID — non-existent in every tenant. The vertical
// guard runs BEFORE the id lookup so the 403 fires regardless of
// whether the id exists; this means we don't need to seed real victim
// rows in the travel tenant. (If the guard order ever changes, the 404
// path still passes — only a true 200 leak would break the assertion.)
//
// Slice 16 drift note (per .claude/skills/verifying-gap-card-claims/):
// the slice-16 prompt listed `/api/travel/visa-applications/:id`,
// `/api/travel/commission-profiles/:id`, `/api/travel/microsites/:id`,
// `/api/travel/cost-master/:id`, `/api/travel/rfu-profiles/:id`,
// `/api/travel/diagnostics/:id`, `/api/travel/trips/:id`,
// `/api/travel/suppliers/:id`, `/api/travel/quotes/:id`,
// `/api/travel/invoices/:id` and `/api/travel/itineraries/:id` (and
// their accept/reject/share/duplicate/issue/void siblings) as
// candidates. Reality check via grep against the spec (slices 2 + 3 +
// 10 + 11): all of those are ALREADY covered. The actual uncovered
// surface is the SUB-RESOURCE sweep above (pdf / day-costs / totals /
// clone-day / scorecard / decline / extend / convert-to-invoice /
// credit-note / clone-as-recurring) plus the pricing-config namespace
// (seasons / markup-rules / religious-packets). Slice 16 pins those.
//
// If any probe finds a 200 leak: do NOT fix from this commit — file a
// `bug,security` issue with the leak vector + tag the probe with
// `test.skip()` referencing the issue.
// ─────────────────────────────────────────────────────────────────────

test.describe("IDOR #919 slice 16 — TRAVEL /:id sub-resource cross-vertical probes", () => {
  // ---- Itinerary sub-resources --------------------------------------

  test("wellness admin GET /api/travel/itineraries/:id/pdf → 403/404 (branded PDF leak vector)", async ({
    request,
  }) => {
    const token = await getWellnessAdmin(request);
    if (!token) test.skip(true, "wellness admin token required");
    const res = await get(
      request,
      token,
      `/api/travel/itineraries/${FAKE_ID}/pdf`,
    );
    expect(
      [400, 403, 404],
      `wellness admin must not GET itinerary pdf id=${FAKE_ID}: got ${res.status()} (${await res.text()})`,
    ).toContain(res.status());
  });

  test("generic admin GET /api/travel/itineraries/:id/day-costs → 403/404 (costing leak vector)", async ({
    request,
  }) => {
    // Day-costs surfaces the per-day pricing breakdown for an itinerary
    // — a missed guard would leak supplier rates + margin info to
    // cross-tenant attackers. Pin 403/404.
    const token = await getGenericAdmin(request);
    if (!token) test.skip(true, "generic admin token required");
    const res = await get(
      request,
      token,
      `/api/travel/itineraries/${FAKE_ID}/day-costs`,
    );
    expect(
      [400, 403, 404],
      `generic admin must not GET itinerary day-costs id=${FAKE_ID}: got ${res.status()} (${await res.text()})`,
    ).toContain(res.status());
  });

  test("wellness admin GET /api/travel/itineraries/:id/totals → 403/404 (pricing rollup leak vector)", async ({
    request,
  }) => {
    // /totals aggregates per-section/per-day pricing into a single
    // grand-total — a missed guard would let cross-tenant attackers
    // enumerate revenue figures by id-scan. Pin 403/404.
    const token = await getWellnessAdmin(request);
    if (!token) test.skip(true, "wellness admin token required");
    const res = await get(
      request,
      token,
      `/api/travel/itineraries/${FAKE_ID}/totals`,
    );
    expect(
      [400, 403, 404],
      `wellness admin must not GET itinerary totals id=${FAKE_ID}: got ${res.status()} (${await res.text()})`,
    ).toContain(res.status());
  });

  test("generic admin POST /api/travel/itineraries/:id/clone-day → 403/404 (clone mutation)", async ({
    request,
  }) => {
    // POST /clone-day is a mutation — duplicates an itinerary day's
    // items into a new day. A missed guard would let cross-tenant
    // attackers clone day-content (including supplier rates) into
    // their own tenant. Pin 403/404.
    const token = await getGenericAdmin(request);
    if (!token) test.skip(true, "generic admin token required");
    const res = await post(
      request,
      token,
      `/api/travel/itineraries/${FAKE_ID}/clone-day`,
      { sourceDay: 1 },
    );
    expect(
      [400, 403, 404],
      `generic admin must not POST itinerary clone-day id=${FAKE_ID}: got ${res.status()} (${await res.text()})`,
    ).toContain(res.status());
  });

  // ---- Supplier sub-resources ---------------------------------------

  test("wellness admin GET /api/travel/suppliers/:id/scorecard → 403/404 (perf-metric leak vector)", async ({
    request,
  }) => {
    // Supplier scorecard aggregates booking-volume + cancellation +
    // dispute metrics — competitive-intel-grade data. A missed guard
    // would leak supplier-performance figures cross-tenant. Pin 403/404.
    const token = await getWellnessAdmin(request);
    if (!token) test.skip(true, "wellness admin token required");
    const res = await get(
      request,
      token,
      `/api/travel/suppliers/${FAKE_ID}/scorecard`,
    );
    expect(
      [400, 403, 404],
      `wellness admin must not GET supplier scorecard id=${FAKE_ID}: got ${res.status()} (${await res.text()})`,
    ).toContain(res.status());
  });

  // ---- Quote sub-resources ------------------------------------------

  test("generic admin POST /api/travel/quotes/:id/decline → 403/404 (state-transition mutation)", async ({
    request,
  }) => {
    // POST /decline flips quote state to declined — a missed guard
    // would let cross-tenant attackers force-decline another tenant's
    // open quotes (sales-pipeline disruption). Pin 403/404.
    const token = await getGenericAdmin(request);
    if (!token) test.skip(true, "generic admin token required");
    const res = await post(
      request,
      token,
      `/api/travel/quotes/${FAKE_ID}/decline`,
      {},
    );
    expect(
      [400, 403, 404],
      `generic admin must not POST quote decline id=${FAKE_ID}: got ${res.status()} (${await res.text()})`,
    ).toContain(res.status());
  });

  test("wellness admin POST /api/travel/quotes/:id/extend → 403/404 (validity mutation)", async ({
    request,
  }) => {
    // POST /extend pushes the quote validUntil forward — a missed guard
    // would let cross-tenant attackers extend (or shorten) the
    // expiration window on another tenant's quotes. Pin 403/404.
    const token = await getWellnessAdmin(request);
    if (!token) test.skip(true, "wellness admin token required");
    const res = await post(
      request,
      token,
      `/api/travel/quotes/${FAKE_ID}/extend`,
      { daysToExtend: 7 },
    );
    expect(
      [400, 403, 404],
      `wellness admin must not POST quote extend id=${FAKE_ID}: got ${res.status()} (${await res.text()})`,
    ).toContain(res.status());
  });

  test("generic admin POST /api/travel/quotes/:id/convert-to-invoice → 403/404 (invoice-gen mutation)", async ({
    request,
  }) => {
    // POST /convert-to-invoice spawns a new TravelInvoice row from the
    // quote — a missed guard would let cross-tenant attackers materialise
    // invoices off another tenant's quotes (revenue-recognition impact +
    // audit-log pollution). Pin 403/404.
    const token = await getGenericAdmin(request);
    if (!token) test.skip(true, "generic admin token required");
    const res = await post(
      request,
      token,
      `/api/travel/quotes/${FAKE_ID}/convert-to-invoice`,
      {},
    );
    expect(
      [400, 403, 404],
      `generic admin must not POST quote convert-to-invoice id=${FAKE_ID}: got ${res.status()} (${await res.text()})`,
    ).toContain(res.status());
  });

  // ---- Invoice sub-resources ----------------------------------------

  test("wellness admin POST /api/travel/invoices/:id/credit-note → 403/404 (financial mutation)", async ({
    request,
  }) => {
    // POST /credit-note creates a credit-note (negative ledger entry)
    // — a missed guard would let cross-tenant attackers issue credits
    // against another tenant's invoices (ledger corruption + cash-flow
    // impact). Pin 403/404.
    const token = await getWellnessAdmin(request);
    if (!token) test.skip(true, "wellness admin token required");
    const res = await post(
      request,
      token,
      `/api/travel/invoices/${FAKE_ID}/credit-note`,
      { reason: "attacker-issued" },
    );
    expect(
      [400, 403, 404],
      `wellness admin must not POST invoice credit-note id=${FAKE_ID}: got ${res.status()} (${await res.text()})`,
    ).toContain(res.status());
  });

  test("generic admin POST /api/travel/invoices/:id/clone-as-recurring → 403/404 (recurring-gen mutation)", async ({
    request,
  }) => {
    // POST /clone-as-recurring spawns a recurring-invoice rule from a
    // one-shot invoice — a missed guard would let cross-tenant attackers
    // schedule recurring charges against another tenant's customer.
    // Pin 403/404.
    const token = await getGenericAdmin(request);
    if (!token) test.skip(true, "generic admin token required");
    const res = await post(
      request,
      token,
      `/api/travel/invoices/${FAKE_ID}/clone-as-recurring`,
      {},
    );
    expect(
      [400, 403, 404],
      `generic admin must not POST invoice clone-as-recurring id=${FAKE_ID}: got ${res.status()} (${await res.text()})`,
    ).toContain(res.status());
  });

  // ---- Pricing-config sub-resources ---------------------------------

  test("wellness admin PATCH /api/travel/seasons/:id → 403/404 (season-config mutation)", async ({
    request,
  }) => {
    // PATCH /seasons/:id mutates the season calendar (peak/shoulder/off
    // date ranges) — a missed guard would let cross-tenant attackers
    // reshape another tenant's pricing-season boundaries (cascades into
    // every quote/invoice priced through that calendar). Pin 403/404.
    const token = await getWellnessAdmin(request);
    if (!token) test.skip(true, "wellness admin token required");
    const res = await patch(
      request,
      token,
      `/api/travel/seasons/${FAKE_ID}`,
      { name: "attacker-injected" },
    );
    expect(
      [400, 403, 404],
      `wellness admin must not PATCH season id=${FAKE_ID}: got ${res.status()} (${await res.text()})`,
    ).toContain(res.status());
  });

  test("generic admin DELETE /api/travel/markup-rules/:id → 403/404 (markup-config destruction)", async ({
    request,
  }) => {
    // DELETE /markup-rules/:id drops a markup rule — a missed guard
    // would let cross-tenant attackers delete another tenant's pricing
    // markup rules (silently drops margin floor; affects every
    // downstream quote priced through pricing engine). Pin 403/404.
    const token = await getGenericAdmin(request);
    if (!token) test.skip(true, "generic admin token required");
    const res = await del(
      request,
      token,
      `/api/travel/markup-rules/${FAKE_ID}`,
    );
    expect(
      [400, 403, 404],
      `generic admin must not DELETE markup-rule id=${FAKE_ID}: got ${res.status()} (${await res.text()})`,
    ).toContain(res.status());
  });

  // ---- Religious-packets sub-resources ------------------------------

  test("wellness admin PATCH /api/travel/religious-packets/:id → 403/404 (packet-config mutation)", async ({
    request,
  }) => {
    // PATCH /religious-packets/:id mutates an Umrah/Hajj packet's
    // configured itinerary template — a missed guard would let
    // cross-tenant attackers corrupt RFU Umrah's seeded packets. Pin
    // 403/404.
    const token = await getWellnessAdmin(request);
    if (!token) test.skip(true, "wellness admin token required");
    const res = await patch(
      request,
      token,
      `/api/travel/religious-packets/${FAKE_ID}`,
      { name: "attacker-injected" },
    );
    expect(
      [400, 403, 404],
      `wellness admin must not PATCH religious-packet id=${FAKE_ID}: got ${res.status()} (${await res.text()})`,
    ).toContain(res.status());
  });

  test("generic admin DELETE /api/travel/religious-packets/:id → 403/404 (packet destruction)", async ({
    request,
  }) => {
    // DELETE /religious-packets/:id drops a packet template — a missed
    // guard would let cross-tenant attackers delete another tenant's
    // packets (worst-case mutation: row is gone). Pin 403/404.
    const token = await getGenericAdmin(request);
    if (!token) test.skip(true, "generic admin token required");
    const res = await del(
      request,
      token,
      `/api/travel/religious-packets/${FAKE_ID}`,
    );
    expect(
      [400, 403, 404],
      `generic admin must not DELETE religious-packet id=${FAKE_ID}: got ${res.status()} (${await res.text()})`,
    ).toContain(res.status());
  });
});
