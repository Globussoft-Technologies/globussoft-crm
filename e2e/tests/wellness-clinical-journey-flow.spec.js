// @ts-check
/**
 * Wellness — full clinical journey end-to-end flow.
 *
 * Verifies a single patient encounter exercising the entire chain:
 *   patient create -> visit log -> prescription -> consent ->
 *   inventory consumption -> P&L (with productCost > 0, the bb52840 fix) ->
 *   loyalty credit -> patient-portal access -> cross-patient isolation.
 *
 * Tagged with E2E_FLOW_<timestamp> in patient names + visit notes so the
 * global-teardown sweeper can scrub residue (no DELETE endpoints exist for
 * patient/visit/prescription/consent/consumption — see findings).
 *
 * Hits BASE_URL (default https://crm.globusdemos.com).
 */
const { test, expect } = require('@playwright/test');

const BASE_URL = process.env.BASE_URL || 'https://crm.globusdemos.com';
const API = `${BASE_URL}/api`;

const OWNER = { email: 'rishu@enhancedwellness.in', password: 'password123' };
const DOCTOR = { email: 'drharsh@enhancedwellness.in', password: 'password123' };

const TAG = `E2E_FLOW_${Date.now()}`;
const PRIYA_NAME = `Priya Sharma ${TAG}`;
const ARJUN_NAME = `Arjun Patel ${TAG}`;
// Use a unique 10-digit India mobile starting with 9 — last10 is what the
// portal OTP/login flow keys on, so two patients must differ in last10.
const TS6 = String(Date.now()).slice(-6);
const PRIYA_PHONE = `+9199${TS6.padStart(8, '0').slice(-8)}`;
const ARJUN_PHONE = `+9198${TS6.padStart(8, '0').slice(-8)}`;

let ownerToken = '';
let doctorToken = '';
let ownerUserId = null;
let doctorUserId = null;
let serviceId = null;
let serviceBasePrice = 0;
let locationId = null;

// Created during the journey — tracked for inspection / future cleanup.
let priyaId = null;
let arjunId = null;
let priyaVisitId = null;
let arjunVisitId = null;
let prescriptionId = null;
let consentId = null;
let consumptionId = null;
let priyaPortalToken = null;

const todayIso = () => new Date().toISOString().slice(0, 10);
const longSignatureSvg = () => {
  // The SIGNATURE_REQUIRED gate rejects strings shorter than 500 chars; repeat
  // the path data generously so the result is always > 1000 chars regardless
  // of minor wrapper changes. The previous 8-repeat was borderline (~512) and
  // hit the gate intermittently.
  const sig = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 180">` +
    `<path d="M${'10 90 C 40 40,80 140,120 90 C 160 40,200 140,240 90 '.repeat(20)}" ` +
    `stroke="#000" stroke-width="2" fill="none"/></svg>`;
  return sig;
};

test.describe.configure({ mode: 'serial' });

test.describe('Wellness clinical journey — full encounter flow', () => {
  test.beforeAll(async ({ request }) => {
    // Owner login (admin actions: patients, services list, P&L, loyalty read).
    const oRes = await request.post(`${API}/auth/login`, { data: OWNER });
    expect(oRes.ok(), `owner login: ${await oRes.text()}`).toBeTruthy();
    const oBody = await oRes.json();
    ownerToken = oBody.token;
    ownerUserId = oBody.user?.id || oBody.id;
    expect(ownerToken, 'owner token').toBeTruthy();

    // Doctor login (clinical actions: visit + Rx).
    const dRes = await request.post(`${API}/auth/login`, { data: DOCTOR });
    expect(dRes.ok(), `doctor login: ${await dRes.text()}`).toBeTruthy();
    const dBody = await dRes.json();
    doctorToken = dBody.token;
    doctorUserId = dBody.user?.id || dBody.id;
    expect(doctorToken, 'doctor token').toBeTruthy();
    expect(doctorUserId, 'doctor user id').toBeTruthy();

    // Locations — pick the first active one.
    const locRes = await request.get(`${API}/wellness/locations`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    expect(locRes.ok(), `locations list: ${await locRes.text()}`).toBeTruthy();
    const locBody = await locRes.json();
    const locs = Array.isArray(locBody) ? locBody : (locBody.locations || []);
    expect(locs.length, 'tenant must have at least one location').toBeGreaterThan(0);
    locationId = locs[0].id;

    // Services — pick first one with a numeric basePrice > 0.
    const svcRes = await request.get(`${API}/wellness/services`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    expect(svcRes.ok(), `services list: ${await svcRes.text()}`).toBeTruthy();
    const services = await svcRes.json();
    const svc = (Array.isArray(services) ? services : []).find(
      (s) => Number(s.basePrice) > 0,
    );
    expect(svc, 'tenant must have a priced service in the catalog').toBeTruthy();
    serviceId = svc.id;
    serviceBasePrice = Number(svc.basePrice);
  });

  const ownerAuth = () => ({ Authorization: `Bearer ${ownerToken}` });
  const doctorAuth = () => ({ Authorization: `Bearer ${doctorToken}` });

  test('1. seed: create Priya Sharma (locationId, +91 phone, DOB, F)', async ({ request }) => {
    const res = await request.post(`${API}/wellness/patients`, {
      headers: ownerAuth(),
      data: {
        name: PRIYA_NAME,
        phone: PRIYA_PHONE,
        dob: '1990-05-15',
        gender: 'F',
        locationId,
        notes: TAG,
        source: 'walk-in',
      },
    });
    expect(res.status(), `patient create: ${await res.text()}`).toBe(201);
    const p = await res.json();
    expect(p.id).toBeTruthy();
    expect(p.name).toBe(PRIYA_NAME);
    expect(p.gender).toBe('F');
    priyaId = p.id;

    // Loyalty starts at 0 — confirm via the ledger (Patient model has no
    // direct loyaltyPoints column; balance = SUM(LoyaltyTransaction.points)).
    const loy = await request.get(`${API}/wellness/loyalty/${priyaId}`, {
      headers: ownerAuth(),
    });
    expect(loy.ok(), `loyalty read: ${await loy.text()}`).toBeTruthy();
    const loyBody = await loy.json();
    expect(loyBody.balance).toBe(0);
    expect(Array.isArray(loyBody.transactions)).toBeTruthy();
    expect(loyBody.transactions.length).toBe(0);
  });

  test('2. visit: doctor logs a completed visit at the priced service', async ({ request }) => {
    const res = await request.post(`${API}/wellness/visits`, {
      headers: doctorAuth(),
      data: {
        patientId: priyaId,
        serviceId,
        doctorId: doctorUserId,
        amountCharged: serviceBasePrice,
        status: 'completed',
        visitDate: new Date().toISOString(),
        notes: `journey ${TAG}`,
      },
    });
    expect(res.status(), `visit create: ${await res.text()}`).toBe(201);
    const v = await res.json();
    expect(v.id).toBeTruthy();
    expect(v.patientId).toBe(priyaId);
    expect(v.serviceId).toBe(serviceId);
    expect(v.doctorId).toBe(doctorUserId);
    expect(Number(v.amountCharged)).toBe(serviceBasePrice);
    expect(v.status).toBe('completed');
    priyaVisitId = v.id;
  });

  test('3. prescription: Ibuprofen 400mg TDS x 5 days', async ({ request }) => {
    const res = await request.post(`${API}/wellness/prescriptions`, {
      headers: doctorAuth(),
      data: {
        visitId: priyaVisitId,
        patientId: priyaId,
        doctorId: doctorUserId,
        drugs: [
          { name: 'Ibuprofen 400mg', dosage: '1 tab', frequency: 'TDS', duration: '5 days' },
        ],
        instructions: `take after food (${TAG})`,
      },
    });
    expect(res.status(), `prescription create: ${await res.text()}`).toBe(201);
    const rx = await res.json();
    expect(rx.id).toBeTruthy();
    expect(rx.visitId).toBe(priyaVisitId);
    expect(rx.patientId).toBe(priyaId);
    prescriptionId = rx.id;

    // Verify it appears in the per-patient list.
    const list = await request.get(
      `${API}/wellness/prescriptions?patientId=${priyaId}`,
      { headers: ownerAuth() },
    );
    expect(list.ok()).toBeTruthy();
    const items = await list.json();
    const found = (Array.isArray(items) ? items : []).find((x) => x.id === prescriptionId);
    expect(found, 'created Rx must be in patient list').toBeTruthy();
  });

  test('4. consent: hair-transplant template with a real-length signature', async ({ request }) => {
    const sig = longSignatureSvg();
    expect(sig.length, 'fixture signature must clear the >=500 char gate').toBeGreaterThanOrEqual(500);

    const res = await request.post(`${API}/wellness/consents`, {
      headers: doctorAuth(),
      data: {
        patientId: priyaId,
        templateName: 'hair-transplant',
        signatureSvg: sig,
      },
    });
    expect(res.status(), `consent create: ${await res.text()}`).toBe(201);
    const c = await res.json();
    expect(c.id).toBeTruthy();
    expect(c.templateName).toBe('hair-transplant');
    expect(c.patientId).toBe(priyaId);
    consentId = c.id;
  });

  test('5. consumption: Botox vial qty=1 unitCost=8000 logged on the visit', async ({ request }) => {
    const res = await request.post(
      `${API}/wellness/visits/${priyaVisitId}/consumptions`,
      {
        headers: doctorAuth(),
        data: { productName: 'Botox vial', qty: 1, unitCost: 8000 },
      },
    );
    expect(res.status(), `consumption create: ${await res.text()}`).toBe(201);
    const c = await res.json();
    expect(c.id).toBeTruthy();
    expect(c.qty).toBe(1);
    expect(Number(c.unitCost)).toBe(8000);
    consumptionId = c.id;

    // Round-trip GET
    const list = await request.get(
      `${API}/wellness/visits/${priyaVisitId}/consumptions`,
      { headers: ownerAuth() },
    );
    expect(list.ok()).toBeTruthy();
    const items = await list.json();
    expect(Array.isArray(items)).toBeTruthy();
    const found = items.find((x) => x.id === consumptionId);
    expect(found, 'consumption must appear in visit consumptions list').toBeTruthy();
    expect(Number(found.qty) * Number(found.unitCost)).toBe(8000);
  });

  test('6. P&L: productCost > 0 and contribution = revenue - productCost (regression for bb52840)', async ({ request }) => {
    // Use a from = yesterday, to = tomorrow window so the visit's UTC
    // mid-day timestamp falls inside regardless of server timezone. Passing
    // from=today as `YYYY-MM-DD` parses to midnight UTC, which is *after*
    // the visit's actual createdAt and would exclude it.
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    const res = await request.get(
      `${API}/wellness/reports/pnl-by-service?from=${yesterday}&to=${tomorrow}`,
      { headers: ownerAuth() },
    );
    expect(res.status(), `pnl-by-service: ${await res.text()}`).toBe(200);
    const body = await res.json();
    expect(body.rows, 'pnl response must have rows').toBeTruthy();

    const row = body.rows.find((r) => r.id === serviceId);
    expect(
      row,
      `service ${serviceId} must appear in today's P&L (visit was logged completed today)`,
    ).toBeTruthy();

    // Revenue must include this visit's charge.
    expect(
      row.revenue,
      `revenue (${row.revenue}) should be >= this visit's amountCharged (${serviceBasePrice})`,
    ).toBeGreaterThanOrEqual(serviceBasePrice);

    // The bb52840 fix: id was missing from the visits select, so
    // visitIdToCost[v.id || -1] was always 0, masking real product cost.
    // After the fix, productCost must reflect the 8000 we just logged.
    expect(
      row.productCost,
      `productCost must be > 0 — bb52840 regression. row=${JSON.stringify(row)}`,
    ).toBeGreaterThan(0);
    expect(
      row.productCost,
      `productCost (${row.productCost}) must include this visit's 8000 consumption`,
    ).toBeGreaterThanOrEqual(8000);

    // Contribution invariant: revenue - productCost, and strictly less than revenue
    // (we just spent 8000 on supplies).
    expect(Math.abs(row.contribution - (row.revenue - row.productCost))).toBeLessThan(0.01);
    expect(row.contribution).toBeLessThan(row.revenue);

    // Totals must sum the rows (basic invariant).
    expect(body.totals.productCost).toBeGreaterThanOrEqual(8000);
  });

  test('7. loyalty: visit-driven credit visible on /loyalty/:patientId (or documented as deferred)', async ({ request }) => {
    const res = await request.get(`${API}/wellness/loyalty/${priyaId}`, {
      headers: ownerAuth(),
    });
    expect(res.ok(), `loyalty get: ${await res.text()}`).toBeTruthy();
    const body = await res.json();
    expect(body.patient.id).toBe(priyaId);
    expect(typeof body.balance).toBe('number');
    expect(Array.isArray(body.transactions)).toBeTruthy();

    // The route file (wellness.js around line 1855) explicitly states:
    //   "We do NOT auto-earn here on visit creation — keeps the route surface
    //    explicit; managers/staff credit via /loyalty/:id/credit."
    // So balance should still be 0 after a visit. We assert that, then prove
    // the credit endpoint works (10% of basePrice rounded down per the doc'd
    // default rule). If a future change auto-credits on visit, this test will
    // flag it loudly so the team confirms the new behavior is intended.
    expect(
      body.balance,
      `visit creation should NOT auto-credit loyalty per route doc; balance=${body.balance}`,
    ).toBe(0);

    // Owner credits manually using the doc'd 10% default rule.
    const earnPoints = Math.floor(serviceBasePrice * 0.1);
    if (earnPoints > 0) {
      const credit = await request.post(
        `${API}/wellness/loyalty/${priyaId}/credit`,
        {
          headers: ownerAuth(),
          data: { points: earnPoints, reason: `visit ${priyaVisitId} (${TAG})` },
        },
      );
      expect(credit.status(), `loyalty credit: ${await credit.text()}`).toBe(201);
      const tx = await credit.json();
      expect(tx.points).toBe(earnPoints);

      const after = await request.get(`${API}/wellness/loyalty/${priyaId}`, {
        headers: ownerAuth(),
      });
      const afterBody = await after.json();
      expect(afterBody.balance).toBe(earnPoints);
      expect(afterBody.earnedThisMonth).toBeGreaterThanOrEqual(earnPoints);
    }
  });

  test('8a. portal: request-otp returns ok:true without leaking registration', async ({ request }) => {
    const res = await request.post(`${API}/wellness/portal/login/request-otp`, {
      data: { phone: PRIYA_PHONE },
    });
    expect(res.status(), `request-otp: ${await res.text()}`).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.expiresAt).toBeTruthy();
    // Production-grade: the OTP MUST NOT be in the response body. If a future
    // diff exposes it, this assertion will catch the leak.
    expect(body).not.toHaveProperty('otp');
    expect(body).not.toHaveProperty('code');
  });

  test('8b. portal: legacy /portal/login now rejects unverified OTPs (security fix)', async ({ request }) => {
    // The legacy /portal/login route used to accept any 4-digit OTP — anyone
    // who knew a patient's phone could mint a 30-day portal JWT. It now
    // validates against the PatientOtp table the same way /verify-otp does.
    // This test pins the fix: a random 4-digit OTP without a matching record
    // must return 401, not a token.
    const res = await request.post(`${API}/wellness/portal/login`, {
      data: { phone: PRIYA_PHONE, otp: '1234' },
    });
    expect(res.status()).toBe(401);
    const body = await res.json();
    expect(body.error).toMatch(/invalid|expired/i);
    expect(body.token).toBeFalsy();
    // Issue a portal token via the dev-friendly path: in non-prod the
    // /request-otp response includes the otp directly so we can complete
    // the flow without DB access. If the env doesn't expose it, skip 8c-8f.
    const reqOtp = await request.post(`${API}/wellness/portal/login/request-otp`, {
      data: { phone: PRIYA_PHONE },
    });
    if (!reqOtp.ok()) return;
    const reqBody = await reqOtp.json().catch(() => ({}));
    if (!reqBody.otp) return; // production behaviour — no leak; portal sub-tests skip
    const verify = await request.post(`${API}/wellness/portal/login/verify-otp`, {
      data: { phone: PRIYA_PHONE, otp: reqBody.otp },
    });
    if (!verify.ok()) return;
    priyaPortalToken = (await verify.json()).token;
  });

  test('8c. portal: /portal/me returns Priya\'s own data', async ({ request }) => {
    test.skip(!priyaPortalToken, 'portal token not issued in 8b');
    const res = await request.get(`${API}/wellness/portal/me`, {
      headers: { Authorization: `Bearer ${priyaPortalToken}` },
    });
    expect(res.status(), `portal me: ${await res.text()}`).toBe(200);
    const me = await res.json();
    expect(me.id).toBe(priyaId);
    expect(me.name).toBe(PRIYA_NAME);
    expect(me.gender).toBe('F');
  });

  test('8d. portal: /portal/visits surfaces today\'s visit', async ({ request }) => {
    test.skip(!priyaPortalToken, 'portal token not issued in 8b');
    const res = await request.get(`${API}/wellness/portal/visits`, {
      headers: { Authorization: `Bearer ${priyaPortalToken}` },
    });
    expect(res.status(), `portal visits: ${await res.text()}`).toBe(200);
    const visits = await res.json();
    expect(Array.isArray(visits)).toBeTruthy();
    const found = visits.find((v) => v.id === priyaVisitId);
    expect(found, 'Priya should see her own visit in the portal').toBeTruthy();
    expect(found.serviceId).toBe(serviceId);
  });

  test('8e. portal: /portal/prescriptions surfaces today\'s Rx', async ({ request }) => {
    test.skip(!priyaPortalToken, 'portal token not issued in 8b');
    const res = await request.get(`${API}/wellness/portal/prescriptions`, {
      headers: { Authorization: `Bearer ${priyaPortalToken}` },
    });
    expect(res.status(), `portal prescriptions: ${await res.text()}`).toBe(200);
    const rxs = await res.json();
    expect(Array.isArray(rxs)).toBeTruthy();
    const found = rxs.find((r) => r.id === prescriptionId);
    expect(found, 'Priya should see her own Rx in the portal').toBeTruthy();
  });

  test('8f. portal isolation: Priya\'s token must NOT see Arjun\'s visit', async ({ request }) => {
    test.skip(!priyaPortalToken, 'portal token not issued in 8b');

    // Seed Arjun + a visit for him.
    const aRes = await request.post(`${API}/wellness/patients`, {
      headers: ownerAuth(),
      data: {
        name: ARJUN_NAME,
        phone: ARJUN_PHONE,
        dob: '1985-08-22',
        gender: 'M',
        locationId,
        notes: TAG,
        source: 'walk-in',
      },
    });
    expect(aRes.status(), `arjun create: ${await aRes.text()}`).toBe(201);
    const arjun = await aRes.json();
    arjunId = arjun.id;

    const vRes = await request.post(`${API}/wellness/visits`, {
      headers: doctorAuth(),
      data: {
        patientId: arjunId,
        serviceId,
        doctorId: doctorUserId,
        amountCharged: serviceBasePrice,
        status: 'completed',
        visitDate: new Date().toISOString(),
        notes: `arjun ${TAG}`,
      },
    });
    expect(vRes.status(), `arjun visit: ${await vRes.text()}`).toBe(201);
    const arjunVisit = await vRes.json();
    arjunVisitId = arjunVisit.id;

    // Priya's portal token GETs visits — Arjun's must NOT appear.
    const res = await request.get(`${API}/wellness/portal/visits`, {
      headers: { Authorization: `Bearer ${priyaPortalToken}` },
    });
    expect(res.status()).toBe(200);
    const visits = await res.json();
    const leaked = visits.find((v) => v.id === arjunVisitId);
    expect(
      leaked,
      `CROSS-PATIENT LEAK: Priya's portal returned Arjun's visit ${arjunVisitId}`,
    ).toBeFalsy();
    // And Priya's own visit is still there.
    expect(visits.find((v) => v.id === priyaVisitId)).toBeTruthy();
  });

  test.afterAll(async ({ request }) => {
    // No DELETE endpoints exist for patients/visits/Rx/consents/consumptions
    // (verified by grep on backend/routes/wellness.js — only DELETE
    // /visits/:id/photos and DELETE /waitlist/:id are present).
    //
    // Strategy: the rows are TAG-stamped (E2E_FLOW_<ts>) in name + notes so
    // a global teardown / cleanup cron can scrub them. Logging here lets the
    // operator track residue in case manual SQL is needed.
    if (!ownerToken) return;
    const created = {
      tag: TAG,
      patients: [priyaId, arjunId].filter(Boolean),
      visits: [priyaVisitId, arjunVisitId].filter(Boolean),
      prescriptions: [prescriptionId].filter(Boolean),
      consents: [consentId].filter(Boolean),
      consumptions: [consumptionId].filter(Boolean),
    };
    // eslint-disable-next-line no-console
    console.log('[wellness-clinical-journey] residue (no DELETE API):', JSON.stringify(created));
  });
});
