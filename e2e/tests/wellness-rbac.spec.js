// @ts-check
/**
 * Wellness RBAC — Issues #207 / #214 / #216
 *
 * Wellness users carry two orthogonal permission axes:
 *   • role         — ADMIN / MANAGER / USER (standard RBAC hierarchy)
 *   • wellnessRole — doctor / professional / telecaller / helper
 *
 * Pre-fix the wellness routes only checked `role`, so a USER+doctor could
 * read the Owner Dashboard, write to the service catalog, etc. This suite
 * exercises every gated endpoint to confirm verifyWellnessRole denies the
 * wrong shape and admit the right one.
 *
 * Test fixtures (seeded by prisma/seed-wellness.js):
 *   rishu@enhancedwellness.in       ADMIN, no wellnessRole
 *   manager@enhancedwellness.in     MANAGER, no wellnessRole         (Pooja Mehta)
 *   drharsh@enhancedwellness.in     USER, wellnessRole=doctor
 *   stylist1@enhancedwellness.in    USER, wellnessRole=professional  (Ravi Pandey)
 *   telecaller@enhancedwellness.in  USER, wellnessRole=telecaller    (Ankita Verma)
 *
 * Run:
 *   cd e2e && BASE_URL=https://crm.globusdemos.com npx playwright test \
 *     tests/wellness-rbac.spec.js --project=chromium
 */
const { test, expect } = require('@playwright/test');

const BASE_URL = process.env.BASE_URL || 'https://crm.globusdemos.com';
const API = `${BASE_URL}/api`;

const FIXTURES = {
  rishu:     { email: 'rishu@enhancedwellness.in',      password: 'password123' },
  pooja:     { email: 'manager@enhancedwellness.in',    password: 'password123' },
  drharsh:   { email: 'drharsh@enhancedwellness.in',    password: 'password123' },
  stylist:   { email: 'stylist1@enhancedwellness.in',   password: 'password123' },
  telecaller:{ email: 'telecaller@enhancedwellness.in', password: 'password123' },
};

const TAG = `E2E_RBAC_${Date.now()}`;

const tokens = {};
let createdServiceIds = [];
let createdConsentIds = [];
let createdRxIds = [];
let testPatientId = null;
let testVisitId = null;

async function login(request, fixture) {
  const r = await request.post(`${API}/auth/login`, { data: fixture });
  expect(r.ok(), `login failed for ${fixture.email}`).toBeTruthy();
  const body = await r.json();
  return body.token;
}

test.describe.serial('Wellness RBAC (#207/#214/#216)', () => {
  test.beforeAll(async ({ request }) => {
    // Mint tokens for every fixture once.
    for (const [k, f] of Object.entries(FIXTURES)) {
      tokens[k] = await login(request, f);
    }

    // Seed a test patient + booked visit (admin) so doctors have something
    // to write Rx against without polluting real production rows.
    const auth = { Authorization: `Bearer ${tokens.rishu}` };
    const pat = await request.post(`${API}/wellness/patients`, {
      headers: auth,
      data: { name: `${TAG} Patient`, phone: `9${Math.floor(100000000 + Math.random() * 899999999)}`, source: 'rbac-test' },
    });
    expect(pat.ok()).toBeTruthy();
    testPatientId = (await pat.json()).id;

    // Pick any service + doctor in the seeded tenant for the visit.
    const svcList = await (await request.get(`${API}/wellness/services`, { headers: auth })).json();
    const serviceId = (svcList[0] || {}).id;
    const drInfo = JSON.parse(Buffer.from(tokens.drharsh.split('.')[1], 'base64').toString());
    const doctorId = drInfo.userId;

    const visit = await request.post(`${API}/wellness/visits`, {
      headers: auth,
      data: {
        patientId: testPatientId,
        serviceId,
        doctorId,
        status: 'booked',
        visitDate: new Date().toISOString(),
      },
    });
    expect(visit.ok()).toBeTruthy();
    testVisitId = (await visit.json()).id;
  });

  test.afterAll(async ({ request }) => {
    const auth = { Authorization: `Bearer ${tokens.rishu}` };
    // Services we created in tests — delete is not exposed; deactivate instead.
    for (const id of createdServiceIds) {
      await request.put(`${API}/wellness/services/${id}`, {
        headers: auth,
        data: { isActive: false, name: `${TAG}_DEACTIVATED_${id}` },
      }).catch(() => {});
    }
    // Patient/Visit/Consent/Rx are clinical artefacts and intentionally have
    // no DELETE per the retention policy at the top of routes/wellness.js.
    // We tag with the TAG prefix so the test data is identifiable in audits.
  });

  // ── Doctor (drharsh) gates ──────────────────────────────────────────

  test('doctor → GET /dashboard → 403 WELLNESS_ROLE_FORBIDDEN', async ({ request }) => {
    const r = await request.get(`${API}/wellness/dashboard`, {
      headers: { Authorization: `Bearer ${tokens.drharsh}` },
    });
    expect(r.status()).toBe(403);
    const body = await r.json();
    expect(body.code).toBe('WELLNESS_ROLE_FORBIDDEN');
  });

  test('doctor → GET /reports/pnl-by-service → 403', async ({ request }) => {
    const r = await request.get(`${API}/wellness/reports/pnl-by-service`, {
      headers: { Authorization: `Bearer ${tokens.drharsh}` },
    });
    expect(r.status()).toBe(403);
  });

  test('doctor → POST /services → 403 (catalog mutation locked)', async ({ request }) => {
    const r = await request.post(`${API}/wellness/services`, {
      headers: { Authorization: `Bearer ${tokens.drharsh}` },
      data: { name: `${TAG} Should Fail`, basePrice: 1000, durationMin: 30 },
    });
    expect(r.status()).toBe(403);
  });

  test('doctor → POST /prescriptions → 201 (clinical write allowed)', async ({ request }) => {
    const r = await request.post(`${API}/wellness/prescriptions`, {
      headers: { Authorization: `Bearer ${tokens.drharsh}` },
      data: {
        visitId: testVisitId,
        patientId: testPatientId,
        drugs: [{ name: `${TAG} Paracetamol 500mg`, frequency: 'TID', durationDays: 3 }],
        instructions: 'After meals',
      },
    });
    expect(r.status()).toBe(201);
    const body = await r.json();
    createdRxIds.push(body.id);
  });

  test('doctor → POST /recommendations/:id/approve → 403', async ({ request }) => {
    // Use a synthetic id — the gate runs before the lookup so the response is 403.
    const r = await request.post(`${API}/wellness/recommendations/999999/approve`, {
      headers: { Authorization: `Bearer ${tokens.drharsh}` },
    });
    expect(r.status()).toBe(403);
  });

  // ── Telecaller (Ankita Verma) gates ────────────────────────────────

  test('telecaller → GET /dashboard → 403', async ({ request }) => {
    const r = await request.get(`${API}/wellness/dashboard`, {
      headers: { Authorization: `Bearer ${tokens.telecaller}` },
    });
    expect(r.status()).toBe(403);
  });

  test('telecaller → POST /prescriptions → 403 (no clinical mandate)', async ({ request }) => {
    const r = await request.post(`${API}/wellness/prescriptions`, {
      headers: { Authorization: `Bearer ${tokens.telecaller}` },
      data: {
        visitId: testVisitId,
        patientId: testPatientId,
        drugs: [{ name: 'should-fail' }],
      },
    });
    expect(r.status()).toBe(403);
  });

  test('telecaller → GET /telecaller/queue → 200 (their queue)', async ({ request }) => {
    const r = await request.get(`${API}/wellness/telecaller/queue`, {
      headers: { Authorization: `Bearer ${tokens.telecaller}` },
    });
    expect(r.ok()).toBeTruthy();
    const body = await r.json();
    expect(Array.isArray(body.leads)).toBeTruthy();
  });

  // ── Professional (stylist1) gates ──────────────────────────────────

  test('professional → POST /consents → 201 (consent capture allowed)', async ({ request }) => {
    // signatureSvg defense-in-depth requires >500 chars (real signatures are KB).
    const sig = 'data:image/png;base64,' + 'A'.repeat(700);
    const r = await request.post(`${API}/wellness/consents`, {
      headers: { Authorization: `Bearer ${tokens.stylist}` },
      data: {
        patientId: testPatientId,
        templateName: `${TAG} Standard Aesthetic Consent`,
        signatureSvg: sig,
      },
    });
    expect(r.status()).toBe(201);
    const body = await r.json();
    createdConsentIds.push(body.id);
  });

  test('professional → POST /prescriptions → 403 (only doctors prescribe)', async ({ request }) => {
    const r = await request.post(`${API}/wellness/prescriptions`, {
      headers: { Authorization: `Bearer ${tokens.stylist}` },
      data: {
        visitId: testVisitId,
        patientId: testPatientId,
        drugs: [{ name: 'should-fail' }],
      },
    });
    expect(r.status()).toBe(403);
  });

  test('professional → GET /reports/pnl-by-service → 403', async ({ request }) => {
    const r = await request.get(`${API}/wellness/reports/pnl-by-service`, {
      headers: { Authorization: `Bearer ${tokens.stylist}` },
    });
    expect(r.status()).toBe(403);
  });

  // ── Manager (Pooja) gates ──────────────────────────────────────────

  test('manager → GET /dashboard → 200', async ({ request }) => {
    const r = await request.get(`${API}/wellness/dashboard`, {
      headers: { Authorization: `Bearer ${tokens.pooja}` },
    });
    expect(r.ok()).toBeTruthy();
  });

  test('manager → POST /prescriptions → 403 (managers do not prescribe)', async ({ request }) => {
    const r = await request.post(`${API}/wellness/prescriptions`, {
      headers: { Authorization: `Bearer ${tokens.pooja}` },
      data: {
        visitId: testVisitId,
        patientId: testPatientId,
        drugs: [{ name: 'should-fail' }],
      },
    });
    expect(r.status()).toBe(403);
  });

  test('manager → POST /services → 201 (catalog edit allowed)', async ({ request }) => {
    const r = await request.post(`${API}/wellness/services`, {
      headers: { Authorization: `Bearer ${tokens.pooja}` },
      data: { name: `${TAG} Manager Service`, basePrice: 1500, durationMin: 45, category: 'wellness' },
    });
    expect(r.status()).toBe(201);
    const body = await r.json();
    createdServiceIds.push(body.id);
  });

  // ── Admin (Rishu) — owner override ─────────────────────────────────

  test('admin → GET /dashboard → 200', async ({ request }) => {
    const r = await request.get(`${API}/wellness/dashboard`, {
      headers: { Authorization: `Bearer ${tokens.rishu}` },
    });
    expect(r.ok()).toBeTruthy();
  });

  test('admin → POST /prescriptions → 201 (owner override on clinical writes)', async ({ request }) => {
    const r = await request.post(`${API}/wellness/prescriptions`, {
      headers: { Authorization: `Bearer ${tokens.rishu}` },
      data: {
        visitId: testVisitId,
        patientId: testPatientId,
        drugs: [{ name: `${TAG} Owner Override Drug` }],
      },
    });
    expect(r.status()).toBe(201);
    const body = await r.json();
    createdRxIds.push(body.id);
  });

  test('admin → POST /services → 201', async ({ request }) => {
    const r = await request.post(`${API}/wellness/services`, {
      headers: { Authorization: `Bearer ${tokens.rishu}` },
      data: { name: `${TAG} Admin Service`, basePrice: 2000, durationMin: 60, category: 'wellness' },
    });
    expect(r.status()).toBe(201);
    const body = await r.json();
    createdServiceIds.push(body.id);
  });

  test('admin → GET /reports/per-location → 200', async ({ request }) => {
    const r = await request.get(`${API}/wellness/reports/per-location`, {
      headers: { Authorization: `Bearer ${tokens.rishu}` },
    });
    expect(r.ok()).toBeTruthy();
  });

  // ── JWT carries wellnessRole ────────────────────────────────────────

  test('login response includes wellnessRole on user', async ({ request }) => {
    const r = await request.post(`${API}/auth/login`, { data: FIXTURES.drharsh });
    const body = await r.json();
    expect(body.user.wellnessRole).toBe('doctor');
  });
});
