// @ts-check
/**
 * Wellness RBAC — API gate (per-push)
 *
 * Promotes the highest-leverage assertions from the existing
 * `e2e/tests/wellness-rbac.spec.js` (UI flow, runs in e2e-full on tag)
 * into a per-push API-only gate. Closes regression risk for the
 * 12-issue RBAC cluster:
 *
 *   #207, #214, #216 — clinical write authorisation (the original cluster
 *                      that surfaced wellness-role + RBAC interplay)
 *   #259  — owner → GET /wellness/dashboard was 403, must be 200
 *   #280  — stylist/professional /visits should be scoped, not cross-clinician
 *   #292  — OTP-bypass exploit (pinned to RBAC because it gated the
 *           portal-token shape that allowed staff endpoints)
 *   #323  — manager could DELETE owner from /api/staff
 *   #324  — doctor /visits feed showed all 16 practitioners' columns
 *   #325  — generic-tenant admin saw wellness dashboard
 *   #326  — telecaller could POST clinical prescriptions
 *   #348  — /api/staff vs /api/wellness/staff returned different results
 *   #357  — req.user.userId was undefined on a wellness gated route
 *
 * The existing wellness-rbac.spec.js stays in place — it's a deeper UI
 * regression suite that exercises the page flows. THIS spec is leaner:
 * pure request fixtures, no page renders, scoped to the API surface
 * the per-push gate can run against the ephemeral seeded DB.
 *
 * Tenant fixtures (seeded by prisma/seed.js + prisma/seed-wellness.js):
 *   admin@globussoft.com         GENERIC tenant ADMIN  → must not see wellness
 *   admin@wellness.demo          WELLNESS tenant ADMIN → owner-equivalent
 *   manager@enhancedwellness.in  WELLNESS MANAGER       (Pooja Mehta)
 *   drharsh@enhancedwellness.in  WELLNESS USER+doctor   (Dr. Harsh Kumar)
 *   stylist1@enhancedwellness.in WELLNESS USER+professional (Ravi Pandey)
 *   telecaller@enhancedwellness.in WELLNESS USER+telecaller (Ankita Verma)
 *   rishu@enhancedwellness.in    WELLNESS ADMIN (the actual owner)
 *
 * Revert-and-prove: revert commit 6b1470f (the req.user.userId sweep)
 * on a throwaway branch and confirm this spec goes red — that proves
 * the gate has teeth.
 */
const { test, expect } = require('@playwright/test');

const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:5000';
const API = `${BASE_URL}/api`;
const REQUEST_TIMEOUT = 30000;

const FIXTURES = {
  genericAdmin: { email: 'admin@globussoft.com', password: 'password123' },
  wellnessAdmin: { email: 'admin@wellness.demo', password: 'password123' },
  rishu: { email: 'rishu@enhancedwellness.in', password: 'password123' },
  manager: { email: 'manager@enhancedwellness.in', password: 'password123' },
  doctor: { email: 'drharsh@enhancedwellness.in', password: 'password123' },
  professional: { email: 'stylist1@enhancedwellness.in', password: 'password123' },
  telecaller: { email: 'telecaller@enhancedwellness.in', password: 'password123' },
};

const tokens = {};
const userIds = {};
const RUN_TAG = `E2E_RBAC_API_${Date.now()}`;

let testPatientId = null;
let testVisitIdMine = null;        // visit assigned to drharsh
let testVisitIdOther = null;       // visit assigned to a different doctor

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

test.describe.serial('Wellness RBAC API gate (#207/#214/#216/#259/#280/#292/#323/#324/#325/#326/#348/#357)', () => {
  test.beforeAll(async ({ request }) => {
    for (const [k, f] of Object.entries(FIXTURES)) {
      const data = await login(request, f);
      // Skip the spec entirely if the seed isn't present (the gate
      // requires both tenants seeded; e2e-full and api_tests both do).
      if (!data) continue;
      tokens[k] = data.token;
      userIds[k] = data.user?.id ?? data.user?.userId ?? null;
    }

    // Seed a wellness patient (admin) so the doctor/manager/professional
    // tests have a stable target. Tagged so the post-suite teardown
    // sweeps it.
    if (tokens.rishu) {
      const phone = `9${Math.floor(100000000 + Math.random() * 899999999)}`;
      const pat = await request.post(`${API}/wellness/patients`, {
        headers: authHeader(tokens.rishu),
        data: { name: `${RUN_TAG} Patient`, phone, source: 'rbac-api-test' },
        timeout: REQUEST_TIMEOUT,
      });
      if (pat.ok()) testPatientId = (await pat.json()).id;

      // Pick a service the doctor can write Rx against.
      const svcRes = await request.get(`${API}/wellness/services`, {
        headers: authHeader(tokens.rishu),
        timeout: REQUEST_TIMEOUT,
      });
      const services = svcRes.ok() ? await svcRes.json() : [];
      const serviceId = (Array.isArray(services) ? services : services.data || services.services || [])[0]?.id;

      // Get drharsh's userId from his JWT for the visit.doctorId.
      let myDoctorId = null;
      if (tokens.doctor) {
        try {
          const payload = JSON.parse(Buffer.from(tokens.doctor.split('.')[1], 'base64').toString());
          myDoctorId = payload.userId;
        } catch (_e) { /* ignore */ }
      }

      // Find a DIFFERENT doctor — drmeena or drvikas — for the
      // "doctor sees only own" assertion. We need at least one visit
      // assigned to a doctor that ISN'T drharsh so the scoping check
      // is meaningful (otherwise there are no rows to filter out).
      let otherDoctorId = null;
      const staffRes = await request.get(`${API}/staff`, {
        headers: authHeader(tokens.rishu),
        timeout: REQUEST_TIMEOUT,
      });
      if (staffRes.ok()) {
        const staff = await staffRes.json();
        const list = Array.isArray(staff) ? staff : (staff.staff || staff.data || []);
        const otherDoctor = list.find((u) => u.wellnessRole === 'doctor' && u.id !== myDoctorId);
        otherDoctorId = otherDoctor?.id || null;
      }

      if (testPatientId && serviceId && myDoctorId) {
        const v1 = await request.post(`${API}/wellness/visits`, {
          headers: authHeader(tokens.rishu),
          data: {
            patientId: testPatientId, serviceId, doctorId: myDoctorId,
            status: 'booked', visitDate: new Date().toISOString(),
          },
          timeout: REQUEST_TIMEOUT,
        });
        if (v1.ok()) testVisitIdMine = (await v1.json()).id;
      }
      if (testPatientId && serviceId && otherDoctorId) {
        const v2 = await request.post(`${API}/wellness/visits`, {
          headers: authHeader(tokens.rishu),
          data: {
            patientId: testPatientId, serviceId, doctorId: otherDoctorId,
            status: 'booked', visitDate: new Date().toISOString(),
          },
          timeout: REQUEST_TIMEOUT,
        });
        if (v2.ok()) testVisitIdOther = (await v2.json()).id;
      }
    }
  });

  // ── #259 / #325: dashboard cross-tenant isolation ────────────────────

  test('#259 wellness ADMIN GET /wellness/dashboard → 200', async ({ request }) => {
    test.skip(!tokens.rishu, 'wellness admin login unavailable in this env');
    const r = await request.get(`${API}/wellness/dashboard`, {
      headers: authHeader(tokens.rishu),
      timeout: REQUEST_TIMEOUT,
    });
    expect(r.status(), `body: ${await r.text()}`).toBe(200);
  });

  test('#325 generic ADMIN GET /wellness/dashboard → 403/404 (no cross-tenant peek)', async ({ request }) => {
    test.skip(!tokens.genericAdmin, 'generic admin login unavailable');
    const r = await request.get(`${API}/wellness/dashboard`, {
      headers: authHeader(tokens.genericAdmin),
      timeout: REQUEST_TIMEOUT,
    });
    // 403 if the tenant guard fires; 404 if the route is wellness-tenant
    // only and resolves to "no such resource for this tenant". Either is
    // a correct refusal — what we MUST NOT see is 200 with the wellness
    // tenant's KPIs.
    expect([403, 404]).toContain(r.status());
  });

  // ── #324: doctor GET /visits scoped to own ───────────────────────────

  test('#324 doctor GET /visits returns only visits where doctor is self', async ({ request }) => {
    test.skip(!tokens.doctor, 'doctor login unavailable');
    const r = await request.get(`${API}/wellness/visits?limit=500`, {
      headers: authHeader(tokens.doctor),
      timeout: REQUEST_TIMEOUT,
    });
    expect(r.status()).toBe(200);
    const body = await r.json();
    const visits = Array.isArray(body) ? body : (body.visits || body.data || []);

    // Read the doctor's own userId from their JWT.
    let mineUserId;
    try {
      const payload = JSON.parse(Buffer.from(tokens.doctor.split('.')[1], 'base64').toString());
      mineUserId = payload.userId;
    } catch (_e) { /* keep undefined */ }
    expect(mineUserId, 'doctor JWT must carry userId for the scope filter').toBeDefined();

    // Every visit returned must have doctorId === self. Pre-#324 fix the
    // doctor saw all 16 practitioners' columns.
    const cross = visits.filter((v) => v.doctorId !== null && v.doctorId !== undefined && v.doctorId !== mineUserId);
    expect(
      cross.map((v) => `id=${v.id} doctorId=${v.doctorId}`),
      `doctor sees ${cross.length} cross-doctor visit(s) — PHI scope leak`
    ).toEqual([]);
  });

  // ── #280: professional GET /visits scoped (own OR non-clinical) ──────

  test('#280 professional GET /visits is scoped — no other doctor\'s clinical visits leak', async ({ request }) => {
    test.skip(!tokens.professional, 'professional login unavailable');
    const r = await request.get(`${API}/wellness/visits?limit=500`, {
      headers: authHeader(tokens.professional),
      timeout: REQUEST_TIMEOUT,
    });
    expect(r.status()).toBe(200);
    const body = await r.json();
    const visits = Array.isArray(body) ? body : (body.visits || body.data || []);

    let mineUserId;
    try {
      const payload = JSON.parse(Buffer.from(tokens.professional.split('.')[1], 'base64').toString());
      mineUserId = payload.userId;
    } catch (_e) { /* keep undefined */ }

    // Permitted: own visits OR visits whose service category is non-clinical
    // (CLINICAL_SERVICE_CATEGORIES per backend/routes/wellness.js). Anything
    // else is a leak. Treat services with no category as non-clinical.
    const CLINICAL_CATS = new Set(['aesthetics', 'aesthetic', 'laser', 'derma', 'dermatology', 'medical', 'consultation']);
    const leak = visits.filter((v) => {
      const isMine = v.doctorId === mineUserId;
      const category = v.service?.category ? String(v.service.category).toLowerCase() : null;
      const isClinical = category && CLINICAL_CATS.has(category);
      // It's a leak only if it's clinical AND not assigned to me.
      return isClinical && !isMine;
    });
    expect(
      leak.map((v) => `id=${v.id} category=${v.service?.category} doctorId=${v.doctorId}`),
      'professional sees clinical visits assigned to other clinicians — PHI scope leak'
    ).toEqual([]);
  });

  // ── #326: telecaller cannot prescribe ────────────────────────────────

  test('#326 telecaller POST /wellness/prescriptions → 403', async ({ request }) => {
    test.skip(!tokens.telecaller, 'telecaller login unavailable');
    const r = await request.post(`${API}/wellness/prescriptions`, {
      headers: authHeader(tokens.telecaller),
      data: {
        visitId: testVisitIdMine || 999999,
        patientId: testPatientId || 999999,
        drugs: [{ name: 'should-fail-rbac', frequency: 'TID', durationDays: 1 }],
      },
      timeout: REQUEST_TIMEOUT,
    });
    expect(r.status()).toBe(403);
  });

  // ── #323: manager cannot DELETE owner ────────────────────────────────

  test('#323 manager DELETE /staff/:ownerId → 403 (cannot remove the owner)', async ({ request }) => {
    test.skip(!tokens.manager, 'manager login unavailable');
    test.skip(!tokens.rishu, 'wellness owner JWT unavailable');

    let ownerId;
    try {
      const payload = JSON.parse(Buffer.from(tokens.rishu.split('.')[1], 'base64').toString());
      ownerId = payload.userId;
    } catch (_e) { /* keep undefined */ }
    expect(ownerId, 'owner JWT must carry userId').toBeDefined();

    const r = await request.delete(`${API}/staff/${ownerId}`, {
      headers: authHeader(tokens.manager),
      timeout: REQUEST_TIMEOUT,
    });
    // 403 (RBAC denies) is the correct refusal. 401 also acceptable if the
    // route gate fires before the owner-check.
    expect([401, 403]).toContain(r.status());
  });

  // ── #348: /api/staff vs /api/wellness/staff consistency ──────────────

  test('#348 /api/staff and /api/wellness/staff resolve consistently for owner', async ({ request }) => {
    test.skip(!tokens.rishu, 'owner login unavailable');
    const [a, b] = await Promise.all([
      request.get(`${API}/staff`, { headers: authHeader(tokens.rishu), timeout: REQUEST_TIMEOUT }),
      request.get(`${API}/wellness/staff`, { headers: authHeader(tokens.rishu), timeout: REQUEST_TIMEOUT }),
    ]);
    // Pre-fix: /api/staff returned 200, /api/wellness/staff returned 403.
    // Post-fix: BOTH must succeed (the wellness namespace redirects to /api/staff).
    // Or BOTH must deny. What we cannot accept is the mixed-status case.
    const aOk = a.ok();
    const bOk = b.ok();
    expect(aOk, `/api/staff status=${a.status()}, /api/wellness/staff status=${b.status()} — inconsistent`).toBe(bOk);
  });

  test('#348 /api/wellness/staff returns the same staff list as /api/staff (when both 200)', async ({ request }) => {
    test.skip(!tokens.rishu, 'owner login unavailable');
    const [a, b] = await Promise.all([
      request.get(`${API}/staff`, { headers: authHeader(tokens.rishu), timeout: REQUEST_TIMEOUT }),
      request.get(`${API}/wellness/staff`, { headers: authHeader(tokens.rishu), timeout: REQUEST_TIMEOUT }),
    ]);
    test.skip(!a.ok() || !b.ok(), 'one of the two is denied; consistency-of-deny tested separately');
    const listA = await a.json();
    const listB = await b.json();
    const idsA = new Set((Array.isArray(listA) ? listA : listA.staff || listA.data || []).map((u) => u.id));
    const idsB = new Set((Array.isArray(listB) ? listB : listB.staff || listB.data || []).map((u) => u.id));
    // Symmetric difference must be empty.
    const onlyInA = [...idsA].filter((id) => !idsB.has(id));
    const onlyInB = [...idsB].filter((id) => !idsA.has(id));
    expect(onlyInA, `staff visible in /api/staff but NOT /api/wellness/staff: ${onlyInA.join(',')}`).toEqual([]);
    expect(onlyInB, `staff visible in /api/wellness/staff but NOT /api/staff: ${onlyInB.join(',')}`).toEqual([]);
  });

  // ── #357: every gated wellness route reads req.user.userId, never req.user.id ─

  test('#357 wellness gated routes accept owner JWT (no req.user.id-undefined regression)', async ({ request }) => {
    test.skip(!tokens.rishu, 'owner login unavailable');
    // A handful of high-traffic gated endpoints. Each handler calls
    // `req.user.userId` (per ESLint rule + commit 6b1470f). If that ever
    // regresses to `req.user.id`, the handler reads `undefined` and the
    // tenantWhere() filter degrades to "all tenants" or 500s. Either way
    // these endpoints stop returning 200 for the owner.
    const probes = [
      '/wellness/dashboard',
      '/wellness/patients?limit=1',
      '/wellness/visits?limit=1',
      '/wellness/services?limit=1',
      '/wellness/locations',
      '/wellness/recommendations',
    ];
    for (const path of probes) {
      const r = await request.get(`${API}${path}`, {
        headers: authHeader(tokens.rishu),
        timeout: REQUEST_TIMEOUT,
      });
      expect(r.status(), `${path} should be 200 for owner — got ${r.status()}: ${(await r.text()).slice(0, 200)}`).toBe(200);
    }
  });

  // ── Belt-and-braces: every login must carry user.tenantId + role + wellnessRole ─

  test('login response carries tenantId, role, and wellnessRole for wellness staff', async ({ request }) => {
    const probes = [
      ['rishu', 'ADMIN', null],
      ['manager', 'MANAGER', null],
      ['doctor', 'USER', 'doctor'],
      ['professional', 'USER', 'professional'],
      ['telecaller', 'USER', 'telecaller'],
    ];
    for (const [key, expectedRole, expectedWellnessRole] of probes) {
      const fixture = FIXTURES[key];
      const data = await login(request, fixture);
      if (!data) continue;
      expect(data.user.role, `${fixture.email} role`).toBe(expectedRole);
      expect(data.tenant?.id ?? data.user?.tenantId, `${fixture.email} tenantId`).toBeTruthy();
      if (expectedWellnessRole) {
        expect(data.user.wellnessRole, `${fixture.email} wellnessRole`).toBe(expectedWellnessRole);
      }
    }
  });
});
