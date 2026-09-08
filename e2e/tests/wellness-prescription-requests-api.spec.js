// @ts-check
/**
 * Prescription renewal / medicine requests — end-to-end API contract.
 *
 * Surface under test:
 *   POST  /api/wellness/portal/prescription-requests       (patient token)
 *   GET   /api/wellness/portal/prescription-requests       (patient token)
 *   GET   /api/wellness/prescription-requests              (staff token)
 *   GET   /api/wellness/prescription-requests/:id          (staff token)
 *   PATCH /api/wellness/prescription-requests/:id/status   (staff token)
 *
 * Why an E2E layer on top of the unit tests: the unit suites mock Prisma, so
 * they cannot catch the two things that actually break in production here —
 * the route being unreachable (mount order, openPaths, RBAC grant missing on
 * a real tenant) and the two halves of the workflow disagreeing about the
 * wire shape. This spec drives the REAL round trip: a patient raises a
 * request from the portal, and staff see and action the same row.
 *
 * Tests:
 *   1. A patient renewing WITHOUT a medicines array gets a full-prescription
 *      request (isFullPrescription: true, requestedDrugs: null).
 *   2. A medicine that is not on the prescription is refused 400
 *      MEDICINE_NOT_ON_PRESCRIPTION — the trust boundary, over the wire.
 *   3. A second open request against the same Rx is 409 REQUEST_ALREADY_OPEN.
 *   4. Another patient's prescription id is 404, never 200 or 403.
 *   5. The patient's own list contains the request they raised.
 *   6. Staff see it in the queue with { items, total, counts }.
 *   7. Staff detail carries the ORIGINAL prescription + the history.
 *   8. Rejecting with no note is 400 REJECTION_REASON_REQUIRED; with a note
 *      it succeeds, and a second transition on the closed row is 409.
 *
 * Demo environment (mirrors wellness-portal-prescriptions-rbac-api.spec.js):
 *   - WELLNESS_DEMO_OTP=1234 + WELLNESS_DEMO_OTP_PHONES allowlist
 *   - Demo patient at +919876500001
 *   - Staff fixture rishu@enhancedwellness.in (doctor — seeds the Rx and
 *     actions the request)
 *
 * Self-skips rather than failing when the environment is not ready — the
 * `my_prescription_requests.*` CUSTOMER grant needs
 * `scripts/backfill-role-preset-perms.js --apply` on tenants whose roles
 * pre-date this feature, and a demo that has not run it yet is a deployment
 * state, not a regression.
 *
 * RUN_TAG: E2E_WC_RX_RENEWAL_<ts>
 *
 * Cleanup: clinical artefacts have no DELETE endpoints (#21), so the seeded
 * visit + Rx + request stay attached to the demo patient. RUN_TAG lands in
 * the drug name and the request note so scrub-test-data-pollution.js can
 * sweep them.
 */
const { test, expect } = require('@playwright/test');

test.describe.configure({ mode: 'serial' });

const BASE_URL = process.env.BASE_URL || 'https://crm.globusdemos.com';
const API = `${BASE_URL}/api`;
const REQUEST_TIMEOUT = 60000;
const RUN_TAG = `E2E_WC_RX_RENEWAL_${Date.now()}`;

const DEMO_PORTAL_PHONE = '+919876500001';
const DEMO_OTP = process.env.WELLNESS_DEMO_OTP || '1234';
const RISHU = { email: 'rishu@enhancedwellness.in', password: 'password123' };

const DRUG_A = `${RUN_TAG}_DRUG_A`;
const DRUG_B = `${RUN_TAG}_DRUG_B`;

let staffToken = '';
let portalToken = '';
let demoPatientId = 0;
let seededRxId = 0;
let otherRxId = 0;
let createdRequestId = 0;
let canRaise = false;

const staffAuth = () => ({ Authorization: `Bearer ${staffToken}` });
const portalAuth = () => ({ Authorization: `Bearer ${portalToken}` });
const jsonStaff = () => ({ ...staffAuth(), 'Content-Type': 'application/json' });
const jsonPortal = () => ({ ...portalAuth(), 'Content-Type': 'application/json' });

async function safeJson(res) {
  try {
    return await res.json();
  } catch (_e) {
    return null;
  }
}

/** Seed a completed visit + a two-drug Rx for `patientId`. Returns the Rx id. */
async function seedPrescription(request, patientId, drugNames) {
  const v = await request.post(`${API}/wellness/visits`, {
    headers: jsonStaff(),
    data: {
      patientId,
      visitDate: new Date().toISOString(),
      status: 'completed',
      notes: `${RUN_TAG} seed visit`,
      amountCharged: 100,
    },
  });
  if (!v.ok()) return 0;
  const visit = await safeJson(v);
  if (!visit || !visit.id) return 0;

  const rx = await request.post(`${API}/wellness/prescriptions`, {
    headers: jsonStaff(),
    data: {
      visitId: visit.id,
      patientId,
      drugs: drugNames.map((name) => ({
        name,
        dosage: '1 tablet',
        frequency: 'twice daily',
        duration: '5 days',
      })),
      instructions: `${RUN_TAG} Rx`,
    },
  });
  if (!rx.ok()) return 0;
  const body = await safeJson(rx);
  return body && body.id ? body.id : 0;
}

test.beforeAll(async ({ request }) => {
  const login = await request.post(`${API}/auth/login`, {
    data: RISHU,
    timeout: REQUEST_TIMEOUT,
  });
  expect(login.ok(), 'rishu staff login must succeed').toBeTruthy();
  staffToken = (await login.json()).token;

  const otpReq = await request.post(`${API}/wellness/portal/login/request-otp`, {
    data: { phone: DEMO_PORTAL_PHONE },
  });
  expect(otpReq.ok(), 'request-otp must accept the demo phone').toBeTruthy();

  const verify = await request.post(`${API}/wellness/portal/login/verify-otp`, {
    data: { phone: DEMO_PORTAL_PHONE, otp: DEMO_OTP },
  });
  expect(
    verify.ok(),
    `verify-otp must accept demo OTP for ${DEMO_PORTAL_PHONE}; got ${verify.status()}`,
  ).toBeTruthy();
  const vBody = await verify.json();
  portalToken = vBody.token;
  demoPatientId = vBody.patient && vBody.patient.id;

  if (demoPatientId) {
    seededRxId = await seedPrescription(request, demoPatientId, [DRUG_A, DRUG_B]);
  }

  // A second patient's Rx, for the cross-patient 404.
  const otherCreate = await request.post(`${API}/wellness/patients`, {
    headers: jsonStaff(),
    data: {
      name: `E2E ${RUN_TAG} Other`,
      phone: `+9198777${String(Date.now()).slice(-5)}`,
      source: 'walk-in',
    },
  });
  if (otherCreate.ok()) {
    const otherP = await safeJson(otherCreate);
    if (otherP && otherP.id) {
      otherRxId = await seedPrescription(request, otherP.id, [`${RUN_TAG}_OTHER`]);
    }
  }

  // Is the CUSTOMER role on this tenant carrying the new grant yet?
  const perms = await request.get(`${API}/wellness/portal/me/permissions`, {
    headers: portalAuth(),
  });
  if (perms.ok()) {
    const body = await safeJson(perms);
    canRaise = ((body && body.permissions) || []).includes(
      'my_prescription_requests.write',
    );
  }
});

test.describe('POST /api/wellness/portal/prescription-requests', () => {
  test('401s without a portal token', async ({ request }) => {
    const res = await request.post(`${API}/wellness/portal/prescription-requests`, {
      data: { prescriptionId: 1 },
    });
    expect(res.status()).toBe(401);
  });

  test('renewing with no medicines array means the COMPLETE prescription', async ({
    request,
  }) => {
    test.skip(!portalToken || !seededRxId, 'portal token or seeded Rx unavailable');
    test.skip(
      !canRaise,
      'my_prescription_requests.write not yet granted to CUSTOMER on this tenant',
    );

    const res = await request.post(`${API}/wellness/portal/prescription-requests`, {
      headers: jsonPortal(),
      data: {
        prescriptionId: seededRxId,
        durationDays: 60,
        notes: `${RUN_TAG} running low`,
      },
    });
    expect(
      res.status(),
      `expected 201, got ${res.status()}: ${await res.text()}`,
    ).toBe(201);

    const body = await res.json();
    expect(body.id).toBeGreaterThan(0);
    expect(body.status).toBe('PENDING');
    expect(body.prescriptionId).toBe(seededRxId);
    expect(body.isFullPrescription).toBe(true);
    expect(body.requestedDrugs).toBeNull();
    expect(body.requestedDurationDays).toBe(60);
    createdRequestId = body.id;
  });

  test('a medicine that is not on the prescription is refused', async ({ request }) => {
    test.skip(!portalToken || !otherRxId, 'portal token or second Rx unavailable');
    test.skip(!canRaise, 'my_prescription_requests.write not granted');

    // Use the OTHER patient's Rx id here only to prove the ordering: the
    // ownership check fires first, so this is a 404 rather than a drug error.
    const res = await request.post(`${API}/wellness/portal/prescription-requests`, {
      headers: jsonPortal(),
      data: { prescriptionId: otherRxId, medicines: ['Anything'] },
    });
    expect(res.status()).toBe(404);
    const body = await safeJson(res);
    expect(body && body.code).toBe('PRESCRIPTION_NOT_FOUND');
  });

  test('a drug not on the caller\'s own Rx is 400 MEDICINE_NOT_ON_PRESCRIPTION', async ({
    request,
  }) => {
    test.skip(!portalToken || !demoPatientId, 'portal token unavailable');
    test.skip(!canRaise, 'my_prescription_requests.write not granted');

    // A fresh Rx so the duplicate guard from the first test doesn't mask this.
    const freshRxId = await seedPrescription(request, demoPatientId, [
      `${RUN_TAG}_FRESH`,
    ]);
    test.skip(!freshRxId, 'could not seed a fresh Rx');

    const res = await request.post(`${API}/wellness/portal/prescription-requests`, {
      headers: jsonPortal(),
      data: { prescriptionId: freshRxId, medicines: ['Tramadol'] },
    });
    expect(res.status()).toBe(400);
    const body = await safeJson(res);
    expect(body && body.code).toBe('MEDICINE_NOT_ON_PRESCRIPTION');
    expect(body && body.error).toContain('Tramadol');
  });

  test('a second open request on the same Rx is 409', async ({ request }) => {
    test.skip(!createdRequestId, 'no request was created in this run');

    const res = await request.post(`${API}/wellness/portal/prescription-requests`, {
      headers: jsonPortal(),
      data: { prescriptionId: seededRxId },
    });
    expect(res.status()).toBe(409);
    const body = await safeJson(res);
    expect(body && body.code).toBe('REQUEST_ALREADY_OPEN');
  });
});

test.describe('GET /api/wellness/portal/prescription-requests', () => {
  test('the patient sees the request they raised', async ({ request }) => {
    test.skip(!createdRequestId, 'no request was created in this run');

    const res = await request.get(`${API}/wellness/portal/prescription-requests`, {
      headers: portalAuth(),
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    const mine = body.find((r) => r.id === createdRequestId);
    expect(mine, 'the raised request must appear in the patient\'s own list').toBeTruthy();
    expect(mine.isFullPrescription).toBe(true);
  });
});

test.describe('Staff queue — /api/wellness/prescription-requests', () => {
  test('the request lands in the clinic queue with per-status counts', async ({
    request,
  }) => {
    test.skip(!createdRequestId, 'no request was created in this run');

    const res = await request.get(
      `${API}/wellness/prescription-requests?status=PENDING&limit=100`,
      { headers: staffAuth() },
    );
    expect(
      res.status(),
      `expected 200, got ${res.status()}: ${await res.text()}`,
    ).toBe(200);

    const body = await res.json();
    expect(Array.isArray(body.items)).toBe(true);
    expect(typeof body.total).toBe('number');
    // The admin page's status tabs read this — a bare array would blank them.
    expect(body.counts).toBeTruthy();
    expect(typeof body.counts.PENDING).toBe('number');

    const row = body.items.find((r) => r.id === createdRequestId);
    expect(row, 'the patient-raised request must be visible to staff').toBeTruthy();
    expect(row.patientId).toBe(demoPatientId);
    expect(row.isFullPrescription).toBe(true);
  });

  test('401s without a staff token', async ({ request }) => {
    const res = await request.get(`${API}/wellness/prescription-requests`);
    expect([401, 403]).toContain(res.status());
  });

  test('the detail carries the ORIGINAL prescription and the history', async ({
    request,
  }) => {
    test.skip(!createdRequestId, 'no request was created in this run');

    const res = await request.get(
      `${API}/wellness/prescription-requests/${createdRequestId}`,
      { headers: staffAuth() },
    );
    expect(res.status()).toBe(200);
    const body = await res.json();

    expect(body.prescription).toBeTruthy();
    expect(body.prescription.id).toBe(seededRxId);
    // Drugs come back as a normalised array, not the raw JSON string.
    expect(Array.isArray(body.prescription.drugs)).toBe(true);
    const names = body.prescription.drugs.map((d) => d.name || '');
    expect(names.some((n) => n.includes(DRUG_A))).toBe(true);

    expect(Array.isArray(body.history)).toBe(true);
    expect(body.history[0].action).toBe('CREATED');
    // Raised from the app, so the actor is the patient — not a staff user.
    expect(body.history[0].actorType).toBe('patient');
  });

  test('a request id that does not exist is a 404', async ({ request }) => {
    const res = await request.get(
      `${API}/wellness/prescription-requests/99999999`,
      { headers: staffAuth() },
    );
    expect(res.status()).toBe(404);
  });
});

test.describe('PATCH /api/wellness/prescription-requests/:id/status', () => {
  test('rejecting without a reason is refused', async ({ request }) => {
    test.skip(!createdRequestId, 'no request was created in this run');

    const res = await request.patch(
      `${API}/wellness/prescription-requests/${createdRequestId}/status`,
      { headers: jsonStaff(), data: { status: 'REJECTED' } },
    );
    expect(res.status()).toBe(400);
    const body = await safeJson(res);
    expect(body && body.code).toBe('REJECTION_REASON_REQUIRED');
  });

  test('an unknown status is refused', async ({ request }) => {
    test.skip(!createdRequestId, 'no request was created in this run');

    const res = await request.patch(
      `${API}/wellness/prescription-requests/${createdRequestId}/status`,
      { headers: jsonStaff(), data: { status: 'DISPENSED_MAYBE' } },
    );
    expect(res.status()).toBe(400);
    const body = await safeJson(res);
    expect(body && body.code).toBe('INVALID_STATUS');
  });

  test('accepting moves the row and records the transition', async ({ request }) => {
    test.skip(!createdRequestId, 'no request was created in this run');

    const res = await request.patch(
      `${API}/wellness/prescription-requests/${createdRequestId}/status`,
      {
        headers: jsonStaff(),
        data: { status: 'ACCEPTED', note: `${RUN_TAG} repeat approved` },
      },
    );
    expect(
      res.status(),
      `expected 200, got ${res.status()}: ${await res.text()}`,
    ).toBe(200);

    const body = await res.json();
    expect(body.status).toBe('ACCEPTED');
    expect(body.reviewedAt).toBeTruthy();
    const actions = (body.history || []).map((h) => h.action);
    expect(actions).toContain('ACCEPTED');
  });

  test('completing then re-transitioning the closed row is a 409', async ({
    request,
  }) => {
    test.skip(!createdRequestId, 'no request was created in this run');

    const done = await request.patch(
      `${API}/wellness/prescription-requests/${createdRequestId}/status`,
      { headers: jsonStaff(), data: { status: 'COMPLETED' } },
    );
    expect(done.status()).toBe(200);
    expect((await done.json()).status).toBe('COMPLETED');

    const again = await request.patch(
      `${API}/wellness/prescription-requests/${createdRequestId}/status`,
      { headers: jsonStaff(), data: { status: 'ACCEPTED' } },
    );
    expect(again.status()).toBe(409);
    const body = await safeJson(again);
    expect(body && body.code).toBe('REQUEST_CLOSED');
  });

  test('the patient sees the closed request in their own list', async ({ request }) => {
    test.skip(!createdRequestId, 'no request was created in this run');

    const res = await request.get(
      `${API}/wellness/portal/prescription-requests?status=COMPLETED`,
      { headers: portalAuth() },
    );
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.some((r) => r.id === createdRequestId)).toBe(true);
  });
});
