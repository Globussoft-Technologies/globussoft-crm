// @ts-check
/**
 * Wellness RBAC regression — per-push gate spec.
 *
 * Companion to `e2e/tests/wellness-rbac-api.spec.js` (the original 11-test
 * gate from 2026-04-30). This regression spec encodes a tighter contract
 * surface so future drift on any of the past wellness-RBAC bugs fails the
 * per-push gate immediately.
 *
 * Bug class covered (each test is pinned to a specific closed issue so the
 * git-blame trail is obvious if a regression lands):
 *
 *   #259  — wellness-tenant ADMIN GET /wellness/dashboard returns 200
 *           (was 403 pre-fix; the cross-tenant gate was ANDed too tight)
 *   #280  — stylist/professional GET /wellness/visits scoped to OWN
 *           clinical work + non-clinical service categories. Pre-fix a
 *           stylist saw every doctor's column on /wellness/calendar.
 *   #323  — manager cannot DELETE owner from /api/staff. Pre-fix the route
 *           gate was verifyRole(['ADMIN']) but no owner-protection check;
 *           a malicious manager elevated by deleting the owner first.
 *   #324  — doctor GET /wellness/visits returns ONLY rows where the doctor
 *           is self. Pre-fix /wellness/calendar showed all 16 practitioners'
 *           columns to any logged-in doctor (PHI scope leak).
 *   #325  — generic-tenant ADMIN GET /wellness/dashboard returns 403
 *           WELLNESS_TENANT_REQUIRED. Pre-fix admin@globussoft.com could
 *           read the wellness tenant's daily KPIs.
 *   #326  — telecaller cannot POST /wellness/prescriptions. Pre-fix the
 *           clinical-write gate was missing; telecallers (Ankita Verma's
 *           role) could author Rx rows.
 *   #348  — /api/staff and /api/wellness/staff resolve consistently.
 *           Post-fix /api/wellness/staff returns 410 Gone with a
 *           `canonical: '/api/staff'` body pointing the client at the
 *           generic namespace. The thing we MUST never see is one
 *           returning 200 + the other 403, or one 200 + the other 404.
 *
 *   #527/#533 (PHI gate, hoisted in cd664f9) — phiReadGate / phiWriteGate
 *           on every previously-ungated wellness clinical route. Without
 *           this, a USER-role JWT (or any wellnessRole NOT in the allowed
 *           list — helpers in particular) could read tenant-wide PHI
 *           or author clinical rows. Two regression-pin tests:
 *             • helper GET /wellness/patients → 403 WELLNESS_ROLE_FORBIDDEN
 *             • helper POST /wellness/visits  → 403 WELLNESS_ROLE_FORBIDDEN
 *           (Helper is OUT of both gates per the cd664f9 commit; the
 *           seed has helper1@enhancedwellness.in carrying role=USER +
 *           wellnessRole='helper'. There is no seeded USER with no
 *           wellnessRole on the wellness tenant — helper is the closest
 *           proxy and exercises the exact same code path.)
 *
 * Why this spec exists alongside wellness-rbac-api.spec.js:
 *   • The original spec authenticates as `rishu` (the seed-wellness owner)
 *     for the multi-staff bootstrap; this one keeps the per-test fixture
 *     pinned to the specific role being asserted, so a test failure points
 *     at exactly one role's regression.
 *   • Adds happy-path baselines for each role (admin / manager / doctor /
 *     professional / telecaller / helper) so a sweeping refactor that
 *     accidentally tightens a gate too far gets caught here, not in
 *     production.
 *   • Adds the cd664f9 #527/#533 helper-on-PHI pins.
 *
 * Tenant fixtures (seed-wellness.js + seed.js):
 *   admin@globussoft.com         GENERIC tenant ADMIN
 *   admin@wellness.demo          WELLNESS tenant ADMIN (role=ADMIN, no wellnessRole)
 *   manager@enhancedwellness.in  WELLNESS MANAGER     (Pooja Mehta)
 *   drharsh@enhancedwellness.in  WELLNESS USER+doctor (Dr. Harsh Kumar)
 *   stylist1@enhancedwellness.in WELLNESS USER+professional (Ravi Pandey)
 *   telecaller@enhancedwellness.in WELLNESS USER+telecaller (Ankita Verma)
 *   helper1@enhancedwellness.in  WELLNESS USER+helper (Mahesh Yadav)
 *
 * stripDangerous reminder: the global middleware deletes
 * `id, createdAt, updatedAt, tenantId, userId, isAdmin, passwordHash,
 * portalPasswordHash` from every request body. We don't reference any of
 * those fields here, so we're safe — but worth re-stating in the header
 * so a future agent doesn't add `userId` to a POST body and watch the
 * test silently regress.
 *
 * RUN_TAG: `E2E_RBAC_REG_<ts>` — matches `/^E2E_RBAC_/` in
 * e2e/test-data-patterns.js, so global-teardown sweeps any stragglers
 * (Patient rows from doctor seed, Visit rows from #324 setup).
 *
 * Revert-and-prove (P0 acceptance from regression-coverage-backlog.md):
 *   1. Revert phiReadGate / phiWriteGate on /wellness/patients
 *      and /wellness/visits in routes/wellness.js (cd664f9 partial revert)
 *   2. Run this spec — confirm RED on the helper PHI pins
 *   3. Revert the revert
 *   4. Run this spec — confirm GREEN
 */
const { test, expect } = require('@playwright/test');

// Several tests below mutate shared seeded state (e.g. create a Patient as
// owner, create a Visit assigned to a specific doctor, then read as
// doctor/stylist) and read it back to verify scope. Pin to serial to avoid
// worker-shuffle races. Same pattern as wellness-clinical-api.spec.js.
test.describe.configure({ mode: 'serial' });

const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:5000';
const API = `${BASE_URL}/api`;
const REQUEST_TIMEOUT = 30000;
const RUN_TAG = `E2E_RBAC_REG_${Date.now()}`;

const FIXTURES = {
  genericAdmin:   { email: 'admin@globussoft.com',          password: 'password123' },
  wellnessAdmin:  { email: 'admin@wellness.demo',           password: 'password123' },
  manager:        { email: 'manager@enhancedwellness.in',   password: 'password123' },
  doctor:         { email: 'drharsh@enhancedwellness.in',   password: 'password123' },
  professional:   { email: 'stylist1@enhancedwellness.in',  password: 'password123' },
  telecaller:     { email: 'telecaller@enhancedwellness.in', password: 'password123' },
  helper:         { email: 'helper1@enhancedwellness.in',   password: 'password123' },
};

const tokens = {};
const userIds = {};

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

// Pull the userId out of a JWT body claim — saves a round-trip when the
// /auth/login response shape varies (some test envs return user.id, some
// user.userId). Mirrors wellness-rbac-api.spec.js's pattern.
function userIdFromJwt(token) {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString());
    return payload.userId;
  } catch (_e) {
    return null;
  }
}

// ── Cleanup tracking ───────────────────────────────────────────────
// Patient: NO DELETE endpoint for non-admins; the global-teardown's
// REGEXP scrub matches `^E2E_RBAC_` (per e2e/test-data-patterns.js)
// and cascades wipe Visit / Prescription rows. We don't actively
// rename / disable here — the RUN_TAG-prefixed name is enough.
let testPatientId = null;
let testVisitMineId = null;       // doctor-assigned to drharsh
let testVisitOtherDoctorId = null; // doctor-assigned to a DIFFERENT doctor

test.beforeAll(async ({ request }) => {
  // Log in as every fixture. Skip individual tests later if a login
  // didn't resolve (rather than failing the whole suite — keeps the gate
  // useful in environments where seed-wellness skipped a user).
  for (const [k, f] of Object.entries(FIXTURES)) {
    const data = await login(request, f);
    if (!data) continue;
    tokens[k] = data.token;
    userIds[k] = data.user?.id ?? userIdFromJwt(data.token);
  }

  // Seed shared state for the #324 scope test. We need:
  //   • One Patient (any tagged name)
  //   • One Visit assigned to drharsh (doctorId = doctor.userId)
  //   • One Visit assigned to a DIFFERENT doctor (so the #324 scope check
  //     has a row to filter OUT — without it the assertion is trivially
  //     true even if the scope filter is broken).
  if (tokens.wellnessAdmin) {
    const phone = `+91 98765 ${String(Math.floor(10000 + Math.random() * 89999))}`;
    const patRes = await request.post(`${API}/wellness/patients`, {
      headers: authHdr(tokens.wellnessAdmin),
      data: { name: `${RUN_TAG} Patient`, phone, source: 'rbac-regression' },
      timeout: REQUEST_TIMEOUT,
    });
    if (patRes.ok()) testPatientId = (await patRes.json()).id;

    // Pick any service the seed-wellness already created.
    const svcRes = await request.get(`${API}/wellness/services?limit=10`, {
      headers: authHdr(tokens.wellnessAdmin),
      timeout: REQUEST_TIMEOUT,
    });
    let serviceId = null;
    if (svcRes.ok()) {
      const body = await svcRes.json();
      const list = Array.isArray(body) ? body : (body.services || body.data || []);
      serviceId = list[0]?.id ?? null;
    }

    const myDoctorId = tokens.doctor ? userIdFromJwt(tokens.doctor) : null;

    // Find a different doctor on the wellness tenant for the #324 setup.
    let otherDoctorId = null;
    const staffRes = await request.get(`${API}/staff`, {
      headers: authHdr(tokens.wellnessAdmin),
      timeout: REQUEST_TIMEOUT,
    });
    if (staffRes.ok()) {
      const staff = await staffRes.json();
      const list = Array.isArray(staff) ? staff : (staff.staff || staff.data || []);
      const otherDoc = list.find((u) => u.wellnessRole === 'doctor' && u.id !== myDoctorId);
      otherDoctorId = otherDoc?.id ?? null;
    }

    if (testPatientId && serviceId && myDoctorId) {
      const v = await request.post(`${API}/wellness/visits`, {
        headers: authHdr(tokens.wellnessAdmin),
        data: {
          patientId: testPatientId, serviceId, doctorId: myDoctorId,
          status: 'booked', visitDate: new Date().toISOString(),
        },
        timeout: REQUEST_TIMEOUT,
      });
      if (v.ok()) testVisitMineId = (await v.json()).id;
    }
    if (testPatientId && serviceId && otherDoctorId) {
      const v = await request.post(`${API}/wellness/visits`, {
        headers: authHdr(tokens.wellnessAdmin),
        data: {
          patientId: testPatientId, serviceId, doctorId: otherDoctorId,
          status: 'booked', visitDate: new Date().toISOString(),
        },
        timeout: REQUEST_TIMEOUT,
      });
      if (v.ok()) testVisitOtherDoctorId = (await v.json()).id;
    }
  }
});

// ──────────────────────────────────────────────────────────────────────
// #259 / #325 — dashboard cross-tenant isolation
// ──────────────────────────────────────────────────────────────────────

test.describe('#259/#325 — wellness dashboard cross-tenant gate', () => {
  test('#259 wellness ADMIN GET /wellness/dashboard → 200', async ({ request }) => {
    test.skip(!tokens.wellnessAdmin, 'wellness admin login unavailable');
    const r = await request.get(`${API}/wellness/dashboard`, {
      headers: authHdr(tokens.wellnessAdmin),
      timeout: REQUEST_TIMEOUT,
    });
    expect(r.status(), `body: ${(await r.text()).slice(0, 200)}`).toBe(200);
  });

  test('#259 wellness MANAGER GET /wellness/dashboard → 200', async ({ request }) => {
    test.skip(!tokens.manager, 'wellness manager login unavailable');
    const r = await request.get(`${API}/wellness/dashboard`, {
      headers: authHdr(tokens.manager),
      timeout: REQUEST_TIMEOUT,
    });
    expect(r.status()).toBe(200);
  });

  test('#325 generic-tenant ADMIN GET /wellness/dashboard → 403 WELLNESS_TENANT_REQUIRED', async ({ request }) => {
    test.skip(!tokens.genericAdmin, 'generic admin login unavailable');
    const r = await request.get(`${API}/wellness/dashboard`, {
      headers: authHdr(tokens.genericAdmin),
      timeout: REQUEST_TIMEOUT,
    });
    // Must be a refusal (403 from the vertical gate, or 404 if mounted under
    // a tenant guard). Never 200 — that was the original bug.
    expect([403, 404], `got ${r.status()}: ${(await r.text()).slice(0, 200)}`).toContain(r.status());
    if (r.status() === 403) {
      const body = await r.json();
      // The verifyWellnessRole middleware emits this exact stable code.
      // Pinning it means a refactor that drops the code field still keeps
      // the 403 status correct, but a refactor that changes the code
      // string surfaces here.
      expect(body.code).toBe('WELLNESS_TENANT_REQUIRED');
    }
  });
});

// ──────────────────────────────────────────────────────────────────────
// #324 — doctor GET /visits scoped to own column
// ──────────────────────────────────────────────────────────────────────

test.describe('#324 — doctor /visits scope', () => {
  test('#324 doctor GET /wellness/visits returns only own bookings (not all 16 practitioners)', async ({ request }) => {
    test.skip(!tokens.doctor, 'doctor login unavailable');
    const r = await request.get(`${API}/wellness/visits?limit=500`, {
      headers: authHdr(tokens.doctor),
      timeout: REQUEST_TIMEOUT,
    });
    expect(r.status()).toBe(200);
    const body = await r.json();
    const visits = Array.isArray(body) ? body : (body.visits || body.data || []);
    const myUserId = userIdFromJwt(tokens.doctor);
    expect(myUserId, 'doctor JWT must carry userId for scope filter').toBeTruthy();

    // Every returned row's doctorId must equal self. Pre-fix a doctor saw
    // every other doctor's column.
    const cross = visits.filter((v) => v.doctorId != null && v.doctorId !== myUserId);
    expect(
      cross.map((v) => `id=${v.id} doctorId=${v.doctorId}`),
      `doctor sees ${cross.length} cross-doctor visit(s) — PHI scope leak`,
    ).toEqual([]);
  });

  test('#324 baseline — at least one visit belonging to a different doctor exists in the seed (the assertion would be trivially true otherwise)', async ({ request }) => {
    test.skip(!tokens.wellnessAdmin, 'wellness admin login unavailable');
    const r = await request.get(`${API}/wellness/visits?limit=500`, {
      headers: authHdr(tokens.wellnessAdmin),
      timeout: REQUEST_TIMEOUT,
    });
    expect(r.status()).toBe(200);
    const body = await r.json();
    const visits = Array.isArray(body) ? body : (body.visits || body.data || []);
    const drharshUserId = tokens.doctor ? userIdFromJwt(tokens.doctor) : null;
    // ADMIN view: must show >= 1 visit assigned to a doctor that ISN'T
    // drharsh. Without that, the #324 scope test above is trivially true.
    const otherDoctorVisits = visits.filter(
      (v) => v.doctorId != null && v.doctorId !== drharshUserId,
    );
    expect(
      otherDoctorVisits.length,
      'no cross-doctor visit exists — #324 scope test is trivially passing; check seed-wellness.js + the beforeAll setup',
    ).toBeGreaterThan(0);
  });
});

// ──────────────────────────────────────────────────────────────────────
// #280 — professional /visits scoped (own clinical OR non-clinical category)
// ──────────────────────────────────────────────────────────────────────

test.describe('#280 — professional /visits scope', () => {
  test('#280 professional GET /wellness/visits — no other clinician\'s clinical visits leak', async ({ request }) => {
    test.skip(!tokens.professional, 'professional login unavailable');
    const r = await request.get(`${API}/wellness/visits?limit=500`, {
      headers: authHdr(tokens.professional),
      timeout: REQUEST_TIMEOUT,
    });
    expect(r.status()).toBe(200);
    const body = await r.json();
    const visits = Array.isArray(body) ? body : (body.visits || body.data || []);
    const myUserId = userIdFromJwt(tokens.professional);

    // Pull the canonical list from routes/wellness.js so the spec stays
    // in sync if the catalog grows. Mirror of CLINICAL_SERVICE_CATEGORIES.
    const CLINICAL_CATS = new Set([
      'hair-transplant', 'hair-restoration', 'hair-concern',
      'skin', 'skin-surgery', 'dermatology', 'aesthetics',
      'body-contouring', 'ayurveda', 'slimming',
    ]);

    const leaks = visits.filter((v) => {
      const isMine = v.doctorId === myUserId;
      const cat = v.service?.category ? String(v.service.category).toLowerCase() : null;
      const isClinical = cat && CLINICAL_CATS.has(cat);
      // It's a leak only if it's clinical AND not assigned to me.
      return isClinical && !isMine;
    });
    expect(
      leaks.map((v) => `id=${v.id} cat=${v.service?.category} doctorId=${v.doctorId}`),
      'professional sees clinical visits assigned to other clinicians — PHI scope leak',
    ).toEqual([]);
  });
});

// ──────────────────────────────────────────────────────────────────────
// #326 — telecaller cannot author clinical Rx
// ──────────────────────────────────────────────────────────────────────

test.describe('#326 — telecaller clinical-write gate', () => {
  test('#326 telecaller POST /wellness/prescriptions → 403', async ({ request }) => {
    test.skip(!tokens.telecaller, 'telecaller login unavailable');
    const r = await request.post(`${API}/wellness/prescriptions`, {
      headers: authHdr(tokens.telecaller),
      data: {
        visitId: testVisitMineId || 999999,
        patientId: testPatientId || 999999,
        drugs: [{ name: 'should-fail-rbac', frequency: 'TID', durationDays: 1 }],
      },
      timeout: REQUEST_TIMEOUT,
    });
    expect(r.status()).toBe(403);
  });

  test('#326 telecaller GET /wellness/patients → 200 (read access preserved for junk-disposition flow)', async ({ request }) => {
    test.skip(!tokens.telecaller, 'telecaller login unavailable');
    // Telecaller is in phiReadGate — they need patient context to dispose
    // junk leads. cd664f9 commit explicitly preserves this.
    const r = await request.get(`${API}/wellness/patients?limit=1`, {
      headers: authHdr(tokens.telecaller),
      timeout: REQUEST_TIMEOUT,
    });
    expect(r.status()).toBe(200);
  });
});

// ──────────────────────────────────────────────────────────────────────
// #323 — manager cannot DELETE owner from /api/staff
// ──────────────────────────────────────────────────────────────────────

test.describe('#323 — owner protection on DELETE /staff/:id', () => {
  test('#323 manager DELETE /api/staff/:ownerId → 401/403 (cannot remove owner)', async ({ request }) => {
    test.skip(!tokens.manager, 'manager login unavailable');
    test.skip(!tokens.wellnessAdmin, 'wellness admin login unavailable');

    const ownerId = userIdFromJwt(tokens.wellnessAdmin);
    expect(ownerId, 'wellness ADMIN JWT must carry userId').toBeTruthy();

    const r = await request.delete(`${API}/staff/${ownerId}`, {
      headers: authHdr(tokens.manager),
      timeout: REQUEST_TIMEOUT,
    });
    // The route gate is verifyRole(['ADMIN']). Manager fails it → 403
    // (or 401 if the gate fires before the role check — both are correct
    // refusals). The thing we MUST NOT see is 200 + a deleted owner.
    expect([401, 403], `got ${r.status()}: ${(await r.text()).slice(0, 200)}`).toContain(r.status());

    // Belt-and-braces: confirm the owner row still exists.
    const verify = await request.get(`${API}/staff`, {
      headers: authHdr(tokens.wellnessAdmin),
      timeout: REQUEST_TIMEOUT,
    });
    if (verify.ok()) {
      const list = await verify.json();
      const items = Array.isArray(list) ? list : (list.staff || list.data || []);
      const stillThere = items.some((u) => u.id === ownerId);
      expect(stillThere, 'owner was deleted by the manager DELETE — #323 has regressed').toBe(true);
    }
  });
});

// ──────────────────────────────────────────────────────────────────────
// #348 — /api/staff vs /api/wellness/staff consistency
// ──────────────────────────────────────────────────────────────────────

test.describe('#348 — /staff namespace consistency', () => {
  test('#348 owner GET /api/staff → 200, GET /api/wellness/staff → 410 Gone (deprecation redirect)', async ({ request }) => {
    test.skip(!tokens.wellnessAdmin, 'wellness admin login unavailable');
    const [a, b] = await Promise.all([
      request.get(`${API}/staff`, { headers: authHdr(tokens.wellnessAdmin), timeout: REQUEST_TIMEOUT }),
      request.get(`${API}/wellness/staff`, { headers: authHdr(tokens.wellnessAdmin), timeout: REQUEST_TIMEOUT }),
    ]);
    expect(a.status(), '/api/staff should be 200 for wellness admin').toBe(200);
    // Post-fix /api/wellness/staff returns 410 Gone with a `canonical`
    // pointer at /api/staff (wellnessNamespacedRedirect). Accept 200
    // too (back-compat — if a future commit reverts the redirect and
    // wires the route up natively, both 200 is also fine).
    expect([200, 410], `got ${b.status()}: ${(await b.text()).slice(0, 200)}`).toContain(b.status());
    // The exact #348 bug was 200 vs 403. Pin: never 403.
    expect(b.status(), 'the #348 bug — never 403 here').not.toBe(403);
    if (b.status() === 410) {
      const body = await b.json();
      // The wellnessNamespacedRedirect helper sets this body shape.
      // Regression-pin so a future refactor that drops the canonical
      // pointer still has to update this assertion.
      expect(body.canonical || body.location || body.redirect).toBeTruthy();
    }
  });

  test('#348 manager sees same /api/staff list (200) as owner — namespace doesn\'t change visibility', async ({ request }) => {
    test.skip(!tokens.manager, 'manager login unavailable');
    const r = await request.get(`${API}/staff`, {
      headers: authHdr(tokens.manager),
      timeout: REQUEST_TIMEOUT,
    });
    // Manager IS allowed to read /api/staff (route gate is verifyToken
    // only on GET). Pre-#348 a manager hitting /api/wellness/staff got 403,
    // creating the inconsistency. We're checking the canonical /staff
    // namespace is open to managers.
    expect(r.status()).toBe(200);
  });
});

// ──────────────────────────────────────────────────────────────────────
// #527/#533 — phiReadGate / phiWriteGate (cd664f9)
// ──────────────────────────────────────────────────────────────────────

test.describe('#527/#533 — PHI read/write gates (cd664f9)', () => {
  test('#527 helper GET /wellness/patients → 403 WELLNESS_ROLE_FORBIDDEN (helper not in phiReadGate)', async ({ request }) => {
    test.skip(!tokens.helper, 'helper login unavailable');
    const r = await request.get(`${API}/wellness/patients?limit=1`, {
      headers: authHdr(tokens.helper),
      timeout: REQUEST_TIMEOUT,
    });
    expect(r.status(), `body: ${(await r.text()).slice(0, 200)}`).toBe(403);
    const body = await r.json();
    expect(body.code).toBe('WELLNESS_ROLE_FORBIDDEN');
    // The middleware also surfaces the allowed-list in the body — pin so
    // a refactor that drops it is visible. Helpers must NOT be in this
    // list (the cd664f9 contract).
    if (Array.isArray(body.allowed)) {
      expect(body.allowed).not.toContain('helper');
    }
  });

  test('#533 helper GET /wellness/patients/:id → 403 (detail surface is symmetric)', async ({ request }) => {
    test.skip(!tokens.helper, 'helper login unavailable');
    test.skip(!testPatientId, 'no patient id seeded — beforeAll skipped');
    const r = await request.get(`${API}/wellness/patients/${testPatientId}`, {
      headers: authHdr(tokens.helper),
      timeout: REQUEST_TIMEOUT,
    });
    expect(r.status()).toBe(403);
  });

  test('#527 helper POST /wellness/visits → 403 (write gate excludes helper)', async ({ request }) => {
    test.skip(!tokens.helper, 'helper login unavailable');
    const r = await request.post(`${API}/wellness/visits`, {
      headers: authHdr(tokens.helper),
      data: {
        patientId: testPatientId || 999999,
        serviceId: 1,
        status: 'booked',
        visitDate: new Date().toISOString(),
      },
      timeout: REQUEST_TIMEOUT,
    });
    expect(r.status()).toBe(403);
    const body = await r.json();
    expect(body.code).toBe('WELLNESS_ROLE_FORBIDDEN');
  });

  test('#527 helper GET /wellness/prescriptions → 403 (Rx is in phiReadGate, helper excluded)', async ({ request }) => {
    test.skip(!tokens.helper, 'helper login unavailable');
    const r = await request.get(`${API}/wellness/prescriptions?limit=1`, {
      headers: authHdr(tokens.helper),
      timeout: REQUEST_TIMEOUT,
    });
    expect(r.status()).toBe(403);
  });

  test('#527 baseline — doctor GET /wellness/patients → 200 (gate passes for doctor)', async ({ request }) => {
    // The flip side of the helper-403 pin — without this, a regression that
    // makes phiReadGate accept NO ONE (a typo'd allowed-list) passes the
    // negative pins above. Belt-and-braces.
    test.skip(!tokens.doctor, 'doctor login unavailable');
    const r = await request.get(`${API}/wellness/patients?limit=1`, {
      headers: authHdr(tokens.doctor),
      timeout: REQUEST_TIMEOUT,
    });
    expect(r.status()).toBe(200);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Happy-path role baselines — every role can hit at least their canonical
// endpoint. Without these, a refactor that tightens phiReadGate too far
// passes the negative tests but breaks production.
// ──────────────────────────────────────────────────────────────────────

test.describe('happy-path role baselines', () => {
  test('wellness ADMIN can GET /wellness/dashboard, /patients, /visits, /services', async ({ request }) => {
    test.skip(!tokens.wellnessAdmin, 'wellness admin login unavailable');
    const probes = [
      '/wellness/dashboard',
      '/wellness/patients?limit=1',
      '/wellness/visits?limit=1',
      '/wellness/services?limit=1',
    ];
    for (const path of probes) {
      const r = await request.get(`${API}${path}`, {
        headers: authHdr(tokens.wellnessAdmin),
        timeout: REQUEST_TIMEOUT,
      });
      expect(r.status(), `${path} for wellness admin → ${r.status()}: ${(await r.text()).slice(0, 200)}`).toBe(200);
    }
  });

  test('doctor can GET /wellness/visits and /wellness/patients (phiReadGate allows doctor)', async ({ request }) => {
    test.skip(!tokens.doctor, 'doctor login unavailable');
    const probes = ['/wellness/visits?limit=1', '/wellness/patients?limit=1'];
    for (const path of probes) {
      const r = await request.get(`${API}${path}`, {
        headers: authHdr(tokens.doctor),
        timeout: REQUEST_TIMEOUT,
      });
      expect(r.status(), `${path} for doctor → ${r.status()}`).toBe(200);
    }
  });

  test('professional can GET /wellness/visits (scoped) and /wellness/patients', async ({ request }) => {
    test.skip(!tokens.professional, 'professional login unavailable');
    const probes = ['/wellness/visits?limit=1', '/wellness/patients?limit=1'];
    for (const path of probes) {
      const r = await request.get(`${API}${path}`, {
        headers: authHdr(tokens.professional),
        timeout: REQUEST_TIMEOUT,
      });
      expect(r.status(), `${path} for professional → ${r.status()}`).toBe(200);
    }
  });

  test('telecaller can GET /wellness/patients (phiReadGate allows telecaller for junk-disposition)', async ({ request }) => {
    test.skip(!tokens.telecaller, 'telecaller login unavailable');
    const r = await request.get(`${API}/wellness/patients?limit=1`, {
      headers: authHdr(tokens.telecaller),
      timeout: REQUEST_TIMEOUT,
    });
    expect(r.status()).toBe(200);
  });

  test('login response carries role + wellnessRole + tenantId for every wellness fixture', async ({ request }) => {
    const probes = [
      ['wellnessAdmin', 'ADMIN',   null],
      ['manager',       'MANAGER', null],
      ['doctor',        'USER',    'doctor'],
      ['professional',  'USER',    'professional'],
      ['telecaller',    'USER',    'telecaller'],
      ['helper',        'USER',    'helper'],
    ];
    for (const [key, expectedRole, expectedWellnessRole] of probes) {
      const f = FIXTURES[key];
      const data = await login(request, f);
      if (!data) continue;
      expect(data.user.role, `${f.email} role`).toBe(expectedRole);
      expect(data.tenant?.id ?? data.user?.tenantId, `${f.email} tenantId`).toBeTruthy();
      if (expectedWellnessRole) {
        expect(data.user.wellnessRole, `${f.email} wellnessRole`).toBe(expectedWellnessRole);
      } else {
        // ADMIN/MANAGER fixtures should NOT carry a wellnessRole — they
        // pass via the verifyWellnessRole "admin"/"manager" special tokens.
        expect(data.user.wellnessRole ?? null).toBeNull();
      }
    }
  });
});
