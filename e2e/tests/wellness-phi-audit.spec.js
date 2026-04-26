// @ts-check
/**
 * PRD §11 — Audit log on every patient record read.
 *
 * HIPAA / DPDP Act compliance: every read of patient PHI must produce an
 * AuditLog row. This spec exercises the wellness PHI READ endpoints and
 * verifies that the audit-viewer surfaces the corresponding rows, that
 * the rows carry no PHI values inside `details`, and that patient-portal
 * self-access is tagged actorType="patient" rather than as a staff user.
 *
 * Endpoint under test for read-back:
 *   GET /api/audit-viewer?action=<ACTION>&limit=N   (ADMIN / MANAGER only)
 *
 * Run:  cd e2e && BASE_URL=https://crm.globusdemos.com \
 *        npx playwright test tests/wellness-phi-audit.spec.js --project=chromium
 */
const { test, expect } = require('@playwright/test');

const BASE_URL = process.env.BASE_URL || 'https://crm.globusdemos.com';
const API = `${BASE_URL}/api`;

const RISHU = { email: 'rishu@enhancedwellness.in', password: 'password123' };

let staffToken = '';
let staffAuth = () => ({ Authorization: `Bearer ${staffToken}` });

// PHI values that MUST NEVER appear in an audit `details` blob.
// We seed each suspect string into the patient/Rx so we can search for it
// later and assert it is absent from the audit row.
const PHI_NEEDLES = ['SECRET_ALLERGY_PEANUT', 'SECRET_NOTE_DIAGNOSIS', 'SECRET_DRUG_NAME'];

/** Fetch most-recent audit rows for a given action, scoped to caller's tenant. */
async function fetchAudit(request, action, limit = 10) {
  const res = await request.get(
    `${API}/audit-viewer?action=${encodeURIComponent(action)}&limit=${limit}`,
    { headers: staffAuth() }
  );
  expect(res.status(), `audit-viewer should return 200 for action=${action}`).toBe(200);
  return res.json();
}

test.describe.configure({ mode: 'serial' });

test.describe('PRD §11 — PHI audit log on every patient read', () => {
  let patientId = 0;
  let visitId = 0;
  let prescriptionId = 0;
  let portalPhone = '';
  let portalToken = '';

  test.beforeAll(async ({ request }) => {
    // Owner login — we need ADMIN to read the audit-viewer afterwards.
    const login = await request.post(`${API}/auth/login`, { data: RISHU });
    expect(login.ok(), 'staff login must succeed').toBeTruthy();
    staffToken = (await login.json()).token;

    // Create a fresh patient with a phone we control, so the portal flow
    // resolves to this row deterministically. Notes/allergy are seeded with
    // the SECRET_* needles so we can later assert they are NOT in audit.
    portalPhone = `+9197${Date.now().toString().slice(-8)}`;
    const pRes = await request.post(`${API}/wellness/patients`, {
      headers: staffAuth(),
      data: {
        name: 'PHI Audit Test Patient',
        phone: portalPhone,
        email: 'phi-audit@example.com',
        dob: '1990-01-15',
        allergies: PHI_NEEDLES[0],
        source: 'walk-in',
      },
    });
    expect(pRes.ok(), 'patient create must succeed').toBeTruthy();
    patientId = (await pRes.json()).id;

    // Create a visit so we can read it back.
    const vRes = await request.post(`${API}/wellness/visits`, {
      headers: staffAuth(),
      data: {
        patientId,
        visitDate: new Date().toISOString(),
        status: 'completed',
        notes: PHI_NEEDLES[1],
        amountCharged: 1500,
      },
    });
    if (vRes.ok()) {
      visitId = (await vRes.json()).id;
    }

    // Create a prescription tied to that visit (doctor role required — owner
    // is ADMIN so allowed).
    if (visitId) {
      const rxRes = await request.post(`${API}/wellness/prescriptions`, {
        headers: staffAuth(),
        data: {
          visitId,
          patientId,
          drugs: [{ name: PHI_NEEDLES[2], dose: '10mg', freq: 'BID' }],
          instructions: 'Take with food',
        },
      });
      if (rxRes.ok()) {
        prescriptionId = (await rxRes.json()).id;
      }
    }
  });

  test('1. Staff GET /patients/:id writes an audit row with no PHI values', async ({ request }) => {
    test.skip(!patientId, 'patient setup failed');

    const before = Date.now();
    const r = await request.get(`${API}/wellness/patients/${patientId}`, { headers: staffAuth() });
    expect(r.status(), 'detail read must succeed').toBe(200);

    // Give the audit write a tick to commit (it's awaited but the response
    // already returned; on slow servers a 500ms grace prevents flakes).
    await new Promise((res) => setTimeout(res, 500));

    const { logs } = await fetchAudit(request, 'PATIENT_DETAIL_READ', 25);
    const ours = logs.find(
      (l) => l.entityId === patientId && new Date(l.createdAt).getTime() >= before - 2000
    );
    expect(ours, `expected a PATIENT_DETAIL_READ row for patient ${patientId}`).toBeTruthy();
    expect(ours.userId, 'staff actor must populate userId').toBeTruthy();

    // CRITICAL: the details blob must list field NAMES, never PHI values.
    const details = ours.details || '';
    for (const needle of PHI_NEEDLES) {
      expect(
        details.includes(needle),
        `details must NOT contain PHI value "${needle}", got: ${details}`
      ).toBe(false);
    }
    // Sanity: the field-name list is present.
    expect(details).toMatch(/accessedFields/);
  });

  test('2. Staff GET /visits/:id writes a VISIT_READ audit row', async ({ request }) => {
    test.skip(!visitId, 'visit setup failed');

    const before = Date.now();
    const r = await request.get(`${API}/wellness/visits/${visitId}`, { headers: staffAuth() });
    expect(r.status()).toBe(200);
    await new Promise((res) => setTimeout(res, 500));

    const { logs } = await fetchAudit(request, 'VISIT_READ', 25);
    const ours = logs.find(
      (l) => l.entityId === visitId && new Date(l.createdAt).getTime() >= before - 2000
    );
    expect(ours, `expected a VISIT_READ row for visit ${visitId}`).toBeTruthy();
    expect(ours.entity).toBe('Visit');
    expect(ours.userId, 'staff actor must populate userId').toBeTruthy();

    // Notes content must NEVER appear in audit details — only a hasNotes bool.
    expect(ours.details || '').not.toContain(PHI_NEEDLES[1]);
    expect(ours.details || '').toMatch(/hasNotes/);
  });

  test('3. Staff GET /prescriptions/:id/pdf writes PRESCRIPTION_PDF_DOWNLOAD', async ({ request }) => {
    test.skip(!prescriptionId, 'prescription setup failed');

    const before = Date.now();
    const r = await request.get(`${API}/wellness/prescriptions/${prescriptionId}/pdf`, {
      headers: staffAuth(),
    });
    expect(r.status(), 'pdf endpoint must succeed').toBe(200);
    await new Promise((res) => setTimeout(res, 500));

    const { logs } = await fetchAudit(request, 'PRESCRIPTION_PDF_DOWNLOAD', 25);
    const ours = logs.find(
      (l) => l.entityId === prescriptionId && new Date(l.createdAt).getTime() >= before - 2000
    );
    expect(ours, `expected a PRESCRIPTION_PDF_DOWNLOAD row for rx ${prescriptionId}`).toBeTruthy();
    expect(ours.entity).toBe('Prescription');

    // Drug name must NOT appear in details — only IDs.
    expect(ours.details || '').not.toContain(PHI_NEEDLES[2]);
    expect(ours.details || '').toMatch(/prescriptionId/);
  });

  test('4. Patient via portal token GET /portal/me logs actorType="patient"', async ({ request }) => {
    test.skip(!patientId, 'patient setup failed');

    // Mint a portal token via request-otp (which surfaces the OTP in non-prod).
    const otpReq = await request.post(`${API}/wellness/portal/login/request-otp`, {
      data: { phone: portalPhone },
    });
    expect(otpReq.ok()).toBeTruthy();
    const otpBody = await otpReq.json();
    test.skip(!otpBody.otp, 'OTP not surfaced — production NODE_ENV; cannot self-mint portal token');

    const verify = await request.post(`${API}/wellness/portal/login/verify-otp`, {
      data: { phone: portalPhone, otp: otpBody.otp },
    });
    expect(verify.ok(), 'verify-otp must succeed for the freshly seeded OTP').toBeTruthy();
    portalToken = (await verify.json()).token;

    const before = Date.now();
    const me = await request.get(`${API}/wellness/portal/me`, {
      headers: { Authorization: `Bearer ${portalToken}` },
    });
    expect(me.ok(), '/portal/me must succeed').toBeTruthy();
    await new Promise((res) => setTimeout(res, 500));

    const { logs } = await fetchAudit(request, 'PATIENT_DETAIL_READ', 25);
    const portalRow = logs.find(
      (l) => l.entityId === patientId && new Date(l.createdAt).getTime() >= before - 2000
    );
    expect(portalRow, 'expected a portal-side PATIENT_DETAIL_READ row').toBeTruthy();
    // Patient self-access: userId is null and details encode actorType.
    expect(portalRow.userId).toBeFalsy();
    expect(portalRow.details || '').toMatch(/_actorType":"patient"/);
    expect(portalRow.details || '').toMatch(/_patientActorId/);
  });

  test('5. Staff GET /patients (list) writes ONE audit row, not N', async ({ request }) => {
    const before = Date.now();
    const r = await request.get(`${API}/wellness/patients?limit=10`, { headers: staffAuth() });
    expect(r.status()).toBe(200);
    const body = await r.json();
    const returned = Array.isArray(body.patients) ? body.patients.length : 0;
    expect(returned, 'list endpoint must return at least one patient').toBeGreaterThan(0);

    await new Promise((res) => setTimeout(res, 500));

    const { logs } = await fetchAudit(request, 'PATIENT_LIST_READ', 50);
    const fresh = logs.filter(
      (l) => new Date(l.createdAt).getTime() >= before - 2000 && (l.userId != null)
    );
    // Exactly one staff-side LIST audit row for this request.
    expect(
      fresh.length,
      `expected exactly 1 PATIENT_LIST_READ row, got ${fresh.length} (per-row logging?)`
    ).toBe(1);
    expect(fresh[0].entityId).toBeNull();
    // Should record `count` but no PHI values.
    expect(fresh[0].details || '').toMatch(/"count":/);
  });
});
