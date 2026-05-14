// @ts-check
/**
 * Wellness portal patient self-DSAR — POST /api/wellness/portal/export.
 *
 * Closes v3.4.8 carry-over #2: prior to this endpoint, patients on the
 * wellness portal had NO mechanism to obtain a copy of their own data,
 * which is required by DPDP Act §15 / GDPR Article 15 (Right of Access).
 * The staff-side analogue (POST /api/gdpr/export/me) is gated to staff
 * JWTs only — middleware/auth.js:23 explicitly rejects portal tokens at
 * every /api/gdpr/* path.
 *
 * Endpoint under test:
 *   POST /api/wellness/portal/export
 *     Auth:   Bearer <portal token> (PORTAL JWT carrying patientId)
 *     200:    {patient, visits, prescriptions, consents, treatmentPlans,
 *              loyaltyTransactions, referrals, counts:{...}, audited, exportedAt}
 *     401:    no token / invalid token / staff JWT (no patientId claim)
 *
 * Audit contract (PRD §11):
 *   - One AuditLog row per request
 *   - action='GDPR_EXPORT_SELF', entity='Patient', entityId=patient.id
 *   - userId IS NULL (portal actor)
 *   - details JSON includes _actorType="patient", _patientActorId=<id>,
 *     reason, source, counts
 *
 * Tenant + cross-patient invariants pinned:
 *   1. The export contains ONLY the requesting patient's rows. A second
 *      patient created in the same tenant must not leak in.
 *   2. The export contains ONLY the requesting patient's tenant's rows.
 *      A patient in tenant B cannot appear in tenant A's export.
 *
 * Test environment:
 *   - BASE_URL — defaults to https://crm.globusdemos.com
 *   - The demo box has WELLNESS_DEMO_OTP=1234 + WELLNESS_DEMO_OTP_PHONES
 *     allowlist defaulting to '9876500001' (#238/#292). The seeded demo
 *     portal patient at +919876500001 ("Demo Portal Patient") is the one
 *     phone whose OTP can be self-minted by the test without DB access.
 *   - Staff fixture rishu@enhancedwellness.in seeds the FK chain (Visit
 *     + Rx + Consent) under that demo patient so we can verify counts.
 *   - Cross-tenant probe uses admin@globussoft.com (generic CRM tenant);
 *     no demo-portal patient exists there so we just confirm the staff
 *     JWT (different tenant) is rejected by verifyPatientToken.
 *
 * RUN_TAG: E2E_WC_PORTAL_DSAR_<ts>. Matched by /^E2E_WC_/ in
 * e2e/test-data-patterns.js so global-teardown sweeps residue.
 *
 * Cleanup: clinical artefacts (Patient/Visit/Rx/ConsentForm) have NO
 * DELETE endpoints (#21). Patients we create in this spec start with
 * "E2E " so the global-teardown REGEXP scrub catches them; cascades
 * wipe Visit + Prescription + ConsentForm. The seeded "Demo Portal
 * Patient" itself is NOT created by this spec — we only attach test
 * artefacts to it, which cascade-rename via the patient name prefix
 * is irrelevant to (the FK chain is anchored on the patient id, not
 * the name). On heavy re-runs the demo patient may accumulate test
 * Visit/Rx rows; that's acceptable demo pollution and gets swept by
 * the periodic scrub-test-data-pollution.js sweep matching tag in
 * notes/payload.
 */
const { test, expect } = require('@playwright/test');

test.describe.configure({ mode: 'serial' });

const BASE_URL = process.env.BASE_URL || 'https://crm.globusdemos.com';
const API = `${BASE_URL}/api`;
const REQUEST_TIMEOUT = 60000;
const RUN_TAG = `E2E_WC_PORTAL_DSAR_${Date.now()}`;

// Demo portal phone — seeded by prisma/seed-wellness.js, allowlisted by
// WELLNESS_DEMO_OTP_PHONES (default '9876500001'). The only phone whose
// OTP we can self-mint via WELLNESS_DEMO_OTP=1234 (#238).
const DEMO_PORTAL_PHONE = '+919876500001';
const DEMO_OTP = process.env.WELLNESS_DEMO_OTP || '1234';

// Staff fixtures — used to seed visits/Rx/consents on the demo patient
// and to probe the cross-tenant rejection path.
const RISHU = { email: 'rishu@enhancedwellness.in', password: 'password123' };
const GENERIC_ADMIN = { email: 'admin@globussoft.com', password: 'password123' };

let staffToken = '';
let crossTenantStaffToken = '';
let portalToken = '';
let demoPatientId = 0;
const seededVisitIds = [];
const seededRxIds = [];
const seededConsentIds = [];

const staffAuth = () => ({ Authorization: `Bearer ${staffToken}` });
const portalAuth = () => ({ Authorization: `Bearer ${portalToken}` });

async function safeJson(res) {
  try { return await res.json(); } catch (_e) { return null; }
}

test.beforeAll(async ({ request }) => {
  // Staff login (wellness tenant) — needed to seed FK rows.
  const login = await request.post(`${API}/auth/login`, {
    data: RISHU,
    timeout: REQUEST_TIMEOUT,
  });
  expect(login.ok(), 'rishu staff login must succeed').toBeTruthy();
  staffToken = (await login.json()).token;

  // Cross-tenant staff JWT (different tenant) — for the auth-gate test.
  const xLogin = await request.post(`${API}/auth/login`, {
    data: GENERIC_ADMIN,
    timeout: REQUEST_TIMEOUT,
  });
  if (xLogin.ok()) {
    crossTenantStaffToken = (await xLogin.json()).token;
  }

  // Mint a portal token for the demo patient via demo-OTP bypass.
  // Two-step: request-otp + verify-otp. The bypass is gated on
  // WELLNESS_DEMO_OTP env-var + a phone allowlist (#292).
  const otpReq = await request.post(`${API}/wellness/portal/login/request-otp`, {
    data: { phone: DEMO_PORTAL_PHONE },
  });
  expect(otpReq.ok(), 'request-otp must accept the demo phone').toBeTruthy();

  const verify = await request.post(`${API}/wellness/portal/login/verify-otp`, {
    data: { phone: DEMO_PORTAL_PHONE, otp: DEMO_OTP },
  });
  expect(
    verify.ok(),
    `verify-otp must accept demo OTP for ${DEMO_PORTAL_PHONE}; got ${verify.status()}: ${await verify.text()}`,
  ).toBeTruthy();
  const verifyBody = await verify.json();
  portalToken = verifyBody.token;
  demoPatientId = verifyBody.patient && verifyBody.patient.id;
  expect(portalToken, 'portal token must be issued').toBeTruthy();
  expect(demoPatientId, 'patient id must be in verify-otp response').toBeTruthy();

  // Seed two visits + one Rx + one consent under the demo patient using
  // the staff JWT. These give us deterministic counts to assert on.
  for (let i = 0; i < 2; i++) {
    const v = await request.post(`${API}/wellness/visits`, {
      headers: { ...staffAuth(), 'Content-Type': 'application/json' },
      data: {
        patientId: demoPatientId,
        visitDate: new Date(Date.now() - i * 86400000).toISOString(),
        status: 'completed',
        notes: `${RUN_TAG} visit ${i}`,
        amountCharged: 500 + i,
      },
    });
    if (v.ok()) {
      const body = await safeJson(v);
      if (body && body.id) seededVisitIds.push(body.id);
    }
  }

  if (seededVisitIds.length > 0) {
    const rx = await request.post(`${API}/wellness/prescriptions`, {
      headers: { ...staffAuth(), 'Content-Type': 'application/json' },
      data: {
        visitId: seededVisitIds[0],
        patientId: demoPatientId,
        drugs: [{ name: `${RUN_TAG}_DRUG`, dose: '5mg', freq: 'OD' }],
        instructions: `${RUN_TAG} Rx instructions`,
      },
    });
    if (rx.ok()) {
      const body = await safeJson(rx);
      if (body && body.id) seededRxIds.push(body.id);
    }
  }

  // Try to seed a consent. The route requires verifyWellnessRole(doctor/
  // professional/admin); rishu is ADMIN so allowed.
  const consent = await request.post(`${API}/wellness/consents`, {
    headers: { ...staffAuth(), 'Content-Type': 'application/json' },
    data: {
      patientId: demoPatientId,
      templateName: 'general',
      signatureSvg: 'data:image/svg+xml;base64,PHN2Zy8+',
    },
  });
  if (consent.ok()) {
    const body = await safeJson(consent);
    if (body && body.id) seededConsentIds.push(body.id);
  }
});

test.describe('POST /api/wellness/portal/export — patient self-DSAR', () => {
  test('1. happy path returns 200 with full envelope shape', async ({ request }) => {
    test.skip(!portalToken, 'portal token unavailable — demo OTP bypass disabled?');

    const res = await request.post(`${API}/wellness/portal/export`, {
      headers: portalAuth(),
    });
    expect(res.status(), `export must return 200; got ${await res.text()}`).toBe(200);

    const body = await res.json();
    expect(body, 'response must be an object').toBeTruthy();

    // Top-level envelope contract.
    expect(body.exportedAt, 'exportedAt timestamp present').toBeTruthy();
    expect(body.patient, 'patient block present').toBeTruthy();
    expect(body.patient.id).toBe(demoPatientId);
    expect(body.patient.tenantId, 'tenantId stripped from public shape').toBeUndefined();
    expect(Array.isArray(body.visits)).toBe(true);
    expect(Array.isArray(body.prescriptions)).toBe(true);
    expect(Array.isArray(body.consents)).toBe(true);
    expect(Array.isArray(body.treatmentPlans)).toBe(true);
    expect(Array.isArray(body.loyaltyTransactions)).toBe(true);
    expect(Array.isArray(body.referrals)).toBe(true);

    // counts block + types
    expect(body.counts, 'counts block present').toBeTruthy();
    expect(body.counts.patient).toBe(1);
    expect(typeof body.counts.visits).toBe('number');
    expect(typeof body.counts.prescriptions).toBe('number');
    expect(typeof body.counts.consents).toBe('number');
    expect(typeof body.counts.treatmentPlans).toBe('number');

    // audited flag — true on success path (writeAudit didn't throw).
    expect(body.audited).toBe(true);
  });

  test('2. patient sees ONLY their own rows (no cross-patient leak)', async ({ request }) => {
    test.skip(!portalToken, 'portal token unavailable');
    test.skip(!staffToken, 'staff token unavailable');

    // Seed a SECOND patient in the same tenant via staff JWT, plus a
    // visit on that other patient. The demo patient's export must NOT
    // include any of these rows.
    const otherCreate = await request.post(`${API}/wellness/patients`, {
      headers: { ...staffAuth(), 'Content-Type': 'application/json' },
      data: {
        name: `E2E ${RUN_TAG} OtherPatient`,
        phone: `+9198765${String(Date.now()).slice(-5)}`,
        source: 'walk-in',
      },
    });
    expect(otherCreate.ok(), 'second patient create must succeed').toBeTruthy();
    const otherPatient = await otherCreate.json();
    const otherPatientId = otherPatient.id;
    expect(otherPatientId).toBeTruthy();
    expect(otherPatientId).not.toBe(demoPatientId);

    let otherVisitId = 0;
    const otherVisit = await request.post(`${API}/wellness/visits`, {
      headers: { ...staffAuth(), 'Content-Type': 'application/json' },
      data: {
        patientId: otherPatientId,
        visitDate: new Date().toISOString(),
        status: 'completed',
        notes: `${RUN_TAG} OTHER patient visit`,
      },
    });
    if (otherVisit.ok()) {
      const body = await safeJson(otherVisit);
      if (body && body.id) otherVisitId = body.id;
    }

    const exportRes = await request.post(`${API}/wellness/portal/export`, {
      headers: portalAuth(),
    });
    expect(exportRes.status()).toBe(200);
    const body = await exportRes.json();

    // Every visit in the export must belong to the demo patient.
    for (const v of body.visits) {
      expect(v.patientId, `visit ${v.id} leaked from other patient`).toBe(demoPatientId);
    }
    // Every prescription too.
    for (const r of body.prescriptions) {
      expect(r.patientId).toBe(demoPatientId);
    }
    // Every consent.
    for (const c of body.consents) {
      expect(c.patientId).toBe(demoPatientId);
    }
    // The seeded other-patient visit MUST NOT be in the export.
    if (otherVisitId) {
      expect(body.visits.find((v) => v.id === otherVisitId)).toBeFalsy();
    }
  });

  test('3. counts match seeded data (>=2 visits, >=1 Rx)', async ({ request }) => {
    test.skip(!portalToken, 'portal token unavailable');

    const res = await request.post(`${API}/wellness/portal/export`, {
      headers: portalAuth(),
    });
    expect(res.status()).toBe(200);
    const body = await res.json();

    // We seeded 2 visits in beforeAll on the demo patient. Use >= since
    // historical seed data may have left other rows on the demo patient
    // (the demo patient is shared seed data).
    expect(body.counts.visits).toBe(body.visits.length);
    expect(body.counts.visits).toBeGreaterThanOrEqual(seededVisitIds.length);

    expect(body.counts.prescriptions).toBe(body.prescriptions.length);
    expect(body.counts.prescriptions).toBeGreaterThanOrEqual(seededRxIds.length);

    expect(body.counts.consents).toBe(body.consents.length);
    expect(body.counts.consents).toBeGreaterThanOrEqual(seededConsentIds.length);
  });

  test('4. auth gate: missing token → 401', async ({ request }) => {
    const res = await request.post(`${API}/wellness/portal/export`);
    // /wellness/portal is in openPaths so the global staff guard is
    // skipped; verifyPatientToken returns 401 for missing token.
    expect(res.status()).toBe(401);
  });

  test('5. auth gate: staff JWT (no patientId claim) → 401', async ({ request }) => {
    test.skip(!staffToken, 'staff token unavailable');
    // Staff tokens are signed with JWT_SECRET; PORTAL_JWT_SECRET falls
    // back to JWT_SECRET when unset (wellness.js:40-43), so the JWT
    // verifies — but `decoded.patientId` is undefined and the middleware
    // returns 401 "Invalid portal token".
    const res = await request.post(`${API}/wellness/portal/export`, {
      headers: { Authorization: `Bearer ${staffToken}` },
    });
    expect(res.status()).toBe(401);
  });

  test('6. auth gate: cross-tenant staff JWT → 401 (no patientId)', async ({ request }) => {
    test.skip(!crossTenantStaffToken, 'cross-tenant staff token unavailable');
    const res = await request.post(`${API}/wellness/portal/export`, {
      headers: { Authorization: `Bearer ${crossTenantStaffToken}` },
    });
    expect(res.status()).toBe(401);
  });

  test('7. auth gate: garbage Bearer → 401', async ({ request }) => {
    const res = await request.post(`${API}/wellness/portal/export`, {
      headers: { Authorization: 'Bearer not.a.real.jwt' },
    });
    expect(res.status()).toBe(401);
  });

  test('8. response includes audited:true (audit row contract)', async ({ request }) => {
    test.skip(!portalToken, 'portal token unavailable');
    // Reading AuditLog requires staff ADMIN access via /api/audit-viewer
    // (a different gate path). We assert the cheap proxy: handler sets
    // `audited: true` ONLY when writeAudit completes without throwing.
    // The wellness-phi-audit.spec.js suite covers the audit-viewer-side
    // assertion for portal-actor reads; this spec stays scoped to the
    // export endpoint's contract.
    const res = await request.post(`${API}/wellness/portal/export`, {
      headers: portalAuth(),
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.audited, 'writeAudit must succeed for self-DSAR').toBe(true);
  });

  test('9. idempotent: second call returns the same shape', async ({ request }) => {
    test.skip(!portalToken, 'portal token unavailable');

    const a = await request.post(`${API}/wellness/portal/export`, {
      headers: portalAuth(),
    });
    expect(a.status()).toBe(200);
    const bodyA = await a.json();

    const b = await request.post(`${API}/wellness/portal/export`, {
      headers: portalAuth(),
    });
    expect(b.status()).toBe(200);
    const bodyB = await b.json();

    // Same patient id, same counts (no rows added in between).
    expect(bodyA.patient.id).toBe(bodyB.patient.id);
    expect(bodyA.counts.visits).toBe(bodyB.counts.visits);
    expect(bodyA.counts.prescriptions).toBe(bodyB.counts.prescriptions);
    expect(bodyA.counts.consents).toBe(bodyB.counts.consents);
    expect(bodyA.counts.treatmentPlans).toBe(bodyB.counts.treatmentPlans);
    // Both must report audited:true on success.
    expect(bodyA.audited).toBe(true);
    expect(bodyB.audited).toBe(true);
  });
});
