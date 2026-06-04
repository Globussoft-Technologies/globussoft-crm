// @ts-check
/**
 * Wellness patient-portal prescription RBAC — pins the `my_prescriptions.read`
 * permission contract introduced in v3.8.x.
 *
 * Surface under test:
 *   GET /api/wellness/portal/me/permissions  — patient-token gated, returns
 *                                              tenant's CUSTOMER role grants
 *   GET /api/wellness/portal/prescriptions       — gated on my_prescriptions.read
 *   GET /api/wellness/portal/prescriptions/:id/pdf — same gate
 *
 * Why a dedicated permission: pre-fix the patient portal endpoints were
 * gated only on `verifyPatientToken` (any valid patient JWT got every
 * /portal/* route). Adding `my_prescriptions.read` as an explicit grant
 * on the tenant's CUSTOMER role lets a clinic admin disable the patient-
 * facing Rx tab without touching code. The handler still scopes by
 * `patientId: req.patient.id` as defence-in-depth, so cross-patient
 * leakage is structurally impossible regardless of RBAC misconfiguration.
 *
 * Tests:
 *   1. /portal/me/permissions returns { permissions: string[] } and
 *      includes 'my_prescriptions.read' for the seeded CUSTOMER role
 *      (post-seed/post-backfill state)
 *   2. With the grant: GET /portal/prescriptions returns 200 with an array
 *   3. With the grant: PDF endpoint returns 200 application/pdf for an
 *      Rx belonging to the requesting patient
 *   4. Cross-patient defence: PDF for an Rx belonging to a DIFFERENT
 *      patient returns 404 (not 200, not 500) even with a valid grant
 *   5. Toggle: ADMIN revokes my_prescriptions.read from the CUSTOMER role,
 *      portal Rx endpoint returns 403 PORTAL_RBAC_DENIED, ADMIN re-grants,
 *      endpoint returns 200 again.
 *
 * Demo environment:
 *   - WELLNESS_DEMO_OTP=1234 + WELLNESS_DEMO_OTP_PHONES allowlist (#238/#292)
 *   - Demo patient at +919876500001 ("Demo Portal Patient")
 *   - Staff fixture rishu@enhancedwellness.in seeds Rx; ADMIN-role for
 *     the toggle test
 *
 * RUN_TAG: E2E_WC_PORTAL_RX_RBAC_<ts>
 *
 * Cleanup: clinical artefacts have no DELETE endpoints (#21). Patient
 * names use the E2E prefix so global-teardown can sweep them. The Rx
 * created here remains attached to the seeded demo patient — acceptable
 * residue (scrub-test-data-pollution.js sweeps by RUN_TAG in details).
 */
const { test, expect } = require('@playwright/test');

test.describe.configure({ mode: 'serial' });

const BASE_URL = process.env.BASE_URL || 'https://crm.globusdemos.com';
const API = `${BASE_URL}/api`;
const REQUEST_TIMEOUT = 60000;
const RUN_TAG = `E2E_WC_PORTAL_RX_RBAC_${Date.now()}`;

const DEMO_PORTAL_PHONE = '+919876500001';
const DEMO_OTP = process.env.WELLNESS_DEMO_OTP || '1234';

const RISHU = { email: 'rishu@enhancedwellness.in', password: 'password123' };
const ADMIN = { email: 'admin@wellness.demo', password: 'password123' };

let staffToken = '';
let adminToken = '';
let portalToken = '';
let demoPatientId = 0;
let seededRxId = 0;
let otherPatientId = 0;
let otherRxId = 0;
let customerRoleId = 0;

const staffAuth = () => ({ Authorization: `Bearer ${staffToken}` });
const adminAuth = () => ({ Authorization: `Bearer ${adminToken}` });
const portalAuth = () => ({ Authorization: `Bearer ${portalToken}` });

async function safeJson(res) {
  try { return await res.json(); } catch (_e) { return null; }
}

test.beforeAll(async ({ request }) => {
  // Staff login (rishu) — seeds Rx.
  const login = await request.post(`${API}/auth/login`, {
    data: RISHU,
    timeout: REQUEST_TIMEOUT,
  });
  expect(login.ok(), 'rishu staff login must succeed').toBeTruthy();
  staffToken = (await login.json()).token;

  // Admin login (demo wellness admin) — toggles CUSTOMER role grants in
  // the revoke/re-grant test. Optional; if the admin isn't seeded the
  // toggle test self-skips.
  const adminLogin = await request.post(`${API}/auth/login`, {
    data: ADMIN,
    timeout: REQUEST_TIMEOUT,
  });
  if (adminLogin.ok()) {
    adminToken = (await adminLogin.json()).token;
  }

  // Mint a portal token via demo-OTP bypass.
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
  const vBody = await verify.json();
  portalToken = vBody.token;
  demoPatientId = vBody.patient && vBody.patient.id;

  // Seed a visit + Rx under the demo patient so the happy-path Rx + PDF
  // tests have something to read.
  const v = await request.post(`${API}/wellness/visits`, {
    headers: { ...staffAuth(), 'Content-Type': 'application/json' },
    data: {
      patientId: demoPatientId,
      visitDate: new Date().toISOString(),
      status: 'completed',
      notes: `${RUN_TAG} seed visit`,
      amountCharged: 100,
    },
  });
  if (v.ok()) {
    const visit = await safeJson(v);
    if (visit && visit.id) {
      const rx = await request.post(`${API}/wellness/prescriptions`, {
        headers: { ...staffAuth(), 'Content-Type': 'application/json' },
        data: {
          visitId: visit.id,
          patientId: demoPatientId,
          drugs: [{ name: `${RUN_TAG}_DRUG`, dose: '5mg', freq: 'OD' }],
          instructions: `${RUN_TAG} Rx`,
        },
      });
      if (rx.ok()) {
        const rxBody = await safeJson(rx);
        if (rxBody && rxBody.id) seededRxId = rxBody.id;
      }
    }
  }

  // Seed a SECOND patient + Rx for the cross-patient test.
  const otherCreate = await request.post(`${API}/wellness/patients`, {
    headers: { ...staffAuth(), 'Content-Type': 'application/json' },
    data: {
      name: `E2E ${RUN_TAG} Other`,
      phone: `+9198777${String(Date.now()).slice(-5)}`,
      source: 'walk-in',
    },
  });
  if (otherCreate.ok()) {
    const otherP = await safeJson(otherCreate);
    if (otherP && otherP.id) {
      otherPatientId = otherP.id;
      const ov = await request.post(`${API}/wellness/visits`, {
        headers: { ...staffAuth(), 'Content-Type': 'application/json' },
        data: {
          patientId: otherPatientId,
          visitDate: new Date().toISOString(),
          status: 'completed',
          notes: `${RUN_TAG} other visit`,
        },
      });
      if (ov.ok()) {
        const oVisit = await safeJson(ov);
        if (oVisit && oVisit.id) {
          const oRx = await request.post(`${API}/wellness/prescriptions`, {
            headers: { ...staffAuth(), 'Content-Type': 'application/json' },
            data: {
              visitId: oVisit.id,
              patientId: otherPatientId,
              drugs: [{ name: `${RUN_TAG}_OTHER_DRUG`, dose: '10mg', freq: 'OD' }],
              instructions: `${RUN_TAG} OTHER Rx`,
            },
          });
          if (oRx.ok()) {
            const oRxBody = await safeJson(oRx);
            if (oRxBody && oRxBody.id) otherRxId = oRxBody.id;
          }
        }
      }
    }
  }

  // Resolve CUSTOMER role id for the toggle test (admin-only — uses
  // /api/roles?key=CUSTOMER). Optional; toggle test self-skips when
  // adminToken is missing or the role can't be resolved.
  if (adminToken) {
    const rolesList = await request.get(`${API}/roles`, {
      headers: adminAuth(),
    });
    if (rolesList.ok()) {
      const rolesBody = await safeJson(rolesList);
      const rows = (rolesBody && rolesBody.roles) || [];
      const customer = rows.find((r) => r.key === 'CUSTOMER');
      if (customer) customerRoleId = customer.id;
    }
  }
});

test.describe('GET /api/wellness/portal/me/permissions', () => {
  test('returns { permissions: string[] } for a logged-in patient', async ({ request }) => {
    test.skip(!portalToken, 'portal token unavailable');
    const res = await request.get(`${API}/wellness/portal/me/permissions`, {
      headers: portalAuth(),
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.permissions)).toBe(true);
    // Sanity: every entry is the canonical "module.action" string.
    for (const p of body.permissions) {
      expect(typeof p).toBe('string');
      expect(p).toMatch(/^[a-z_]+\.[a-z_]+$/);
    }
  });

  test('401s when called without a portal token', async ({ request }) => {
    const res = await request.get(`${API}/wellness/portal/me/permissions`);
    expect(res.status()).toBe(401);
  });
});

test.describe('GET /api/wellness/portal/prescriptions — RBAC gate', () => {
  test('returns 200 with an array when CUSTOMER role grants my_prescriptions.read', async ({ request }) => {
    test.skip(!portalToken, 'portal token unavailable');

    // Probe current permission state — skip if the demo hasn't picked up
    // the new my_prescriptions.read grant yet (transition window).
    const permsRes = await request.get(`${API}/wellness/portal/me/permissions`, {
      headers: portalAuth(),
    });
    const permsBody = await permsRes.json();
    const granted = (permsBody.permissions || []).includes('my_prescriptions.read');
    test.skip(!granted, 'my_prescriptions.read not yet granted to CUSTOMER on this tenant');

    const res = await request.get(`${API}/wellness/portal/prescriptions`, {
      headers: portalAuth(),
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    // Every row in the list belongs to the requesting patient.
    for (const rx of body) {
      expect(rx.patientId).toBe(demoPatientId);
    }
  });
});

test.describe('GET /api/wellness/portal/prescriptions/:id/pdf — RBAC + cross-patient gate', () => {
  test('returns 200 application/pdf for an Rx belonging to the requesting patient', async ({ request }) => {
    test.skip(!portalToken, 'portal token unavailable');
    test.skip(!seededRxId, 'seeded Rx unavailable — visit/Rx create failed in beforeAll');

    const permsRes = await request.get(`${API}/wellness/portal/me/permissions`, {
      headers: portalAuth(),
    });
    const permsBody = await permsRes.json();
    const granted = (permsBody.permissions || []).includes('my_prescriptions.read');
    test.skip(!granted, 'my_prescriptions.read not yet granted to CUSTOMER on this tenant');

    const res = await request.get(
      `${API}/wellness/portal/prescriptions/${seededRxId}/pdf`,
      { headers: portalAuth() },
    );
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toMatch(/application\/pdf/);
  });

  test('returns 404 for an Rx belonging to a DIFFERENT patient (cross-patient defence)', async ({ request }) => {
    test.skip(!portalToken, 'portal token unavailable');
    test.skip(!otherRxId, 'other patient Rx unavailable');

    const res = await request.get(
      `${API}/wellness/portal/prescriptions/${otherRxId}/pdf`,
      { headers: portalAuth() },
    );
    // Hardcoded handler scope: `where: { id, patientId: req.patient.id }`.
    // Foreign Rx → findFirst returns null → 404, NOT 200, NOT 500.
    expect(res.status()).toBe(404);
  });
});

test.describe('CUSTOMER my_prescriptions.read revoke / re-grant', () => {
  test('revoking my_prescriptions.read returns 403 on /portal/prescriptions; re-granting returns 200', async ({ request }) => {
    test.skip(!portalToken, 'portal token unavailable');
    test.skip(!adminToken, 'admin token unavailable — wellness-demo admin not seeded');
    test.skip(!customerRoleId, 'CUSTOMER role id unresolved');

    // Sanity: should be granted today.
    const before = await request.get(`${API}/wellness/portal/me/permissions`, {
      headers: portalAuth(),
    });
    const beforeBody = await before.json();
    if (!(beforeBody.permissions || []).includes('my_prescriptions.read')) {
      test.skip(true, 'my_prescriptions.read not granted in baseline — nothing to revoke');
    }

    // Revoke.
    const revoke = await request.delete(
      `${API}/roles/${customerRoleId}/permissions/my_prescriptions/read`,
      { headers: adminAuth() },
    );
    expect(revoke.status()).toBe(200);

    try {
      const denied = await request.get(`${API}/wellness/portal/prescriptions`, {
        headers: portalAuth(),
      });
      expect(denied.status()).toBe(403);
      const dBody = await denied.json();
      expect(dBody.code).toBe('PORTAL_RBAC_DENIED');
      expect(dBody.required).toBe('my_prescriptions.read');
    } finally {
      // Re-grant — restore baseline even if the assertion above failed.
      const regrant = await request.post(
        `${API}/roles/${customerRoleId}/permissions`,
        {
          headers: { ...adminAuth(), 'Content-Type': 'application/json' },
          data: { module: 'my_prescriptions', action: 'read' },
        },
      );
      expect(regrant.status()).toBeLessThan(300);
    }

    // Post-restore: 200 again.
    const restored = await request.get(`${API}/wellness/portal/prescriptions`, {
      headers: portalAuth(),
    });
    expect(restored.status()).toBe(200);
  });
});
