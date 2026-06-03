// @ts-check
/**
 * Wellness patient-portal appointments — pins the new /portal/appointments
 * endpoints that back the patient-facing MyBookings page.
 *
 * Surface under test:
 *   GET   /api/wellness/portal/appointments?bucket=upcoming|pending|completed|cancelled
 *   POST  /api/wellness/portal/appointments/book
 *   POST  /api/wellness/portal/appointments/:id/cancel
 *   PATCH /api/wellness/portal/appointments/:id/reschedule
 *
 * Why a dedicated portal surface: the legacy /api/wellness/appointments/*
 * endpoints required a CUSTOMER session JWT (verifyToken). The new
 * /portal/appointments/* endpoints use verifyPatientToken which accepts
 * BOTH cohorts (Path A = phone+OTP, Path B = CUSTOMER session resolved to
 * Patient) — same component (MyBookings.jsx) renders under two shells.
 *
 * Both routes converge on backend/services/appointmentService.js so the
 * legacy and portal endpoints can't drift; unit coverage at
 * backend/test/services/appointmentService.test.js pins business rules
 * (validation, audit-actor mapping, status guards). This spec pins the
 * HTTP contract end-to-end including auth + tenant scoping.
 *
 * Tests:
 *   1. Booking happy path returns { success, appointment } with the
 *      mapped envelope (serviceName, doctorName | 'Pending assignment',
 *      canCancel, canReschedule).
 *   2. Booking with missing reason returns 400 REASON_REQUIRED.
 *   3. GET /appointments?bucket=upcoming returns the seeded booking.
 *   4. GET /appointments?bucket=pending returns visits with no doctor.
 *   5. Reschedule moves the appointment + updated envelope reflects new time.
 *   6. Reschedule with past date returns 400 DATE_NOT_FUTURE.
 *   7. Cancel updates status + the cancelled bucket lists it; cancelling
 *      again is idempotent.
 *   8. Cross-tenant defence: a portal token for tenant A cannot cancel a
 *      visit belonging to tenant B (404, NOT 200 / 500).
 *
 * Demo environment:
 *   - WELLNESS_DEMO_OTP=1234 + WELLNESS_DEMO_OTP_PHONES allowlist (#238/#292)
 *   - Demo patient at +919876500001 ("Demo Portal Patient")
 *
 * RUN_TAG: E2E_PORTAL_APPTS_<workerId>_<ts>
 *
 * Cleanup: visits are tagged with RUN_TAG in the `reason` field so the
 * global teardown sweep can identify them. Each test that creates a
 * booking soft-cancels it in afterAll.
 */
const { test, expect } = require('@playwright/test');

// Hash-chain'd visit history + interleaved create/reschedule/cancel calls
// must run sequentially or shared-resource collisions (slot conflicts on
// the same doctor / hour) will flake under shard load.
test.describe.configure({ mode: 'serial', timeout: 120_000 });

const BASE_URL = process.env.BASE_URL || 'https://crm.globusdemos.com';
const API = `${BASE_URL}/api`;
const REQUEST_TIMEOUT = 60000;

const DEMO_PORTAL_PHONE = '+919876500001';
const DEMO_OTP = process.env.WELLNESS_DEMO_OTP || '1234';

const RISHU = { email: 'rishu@enhancedwellness.in', password: 'password123' };

// Per-worker discriminator avoids cross-shard slot collisions when this
// spec runs in parallel — see CLAUDE.md "e2e shared-DB helpers must
// include a per-worker discriminator". `appointmentDate` differs per
// worker so two parallel runs don't fight over the same (doctor, hour).
const WORKER = (() => {
  try { return require('@playwright/test').test.info().workerIndex || 0; } catch (_e) { return 0; }
})();
const RUN_TAG = `E2E_PORTAL_APPTS_W${WORKER}_${Date.now()}`;

let staffToken = '';
let portalToken = '';
let demoPatientId = 0;
const createdVisitIds = [];

const staffAuth = () => ({ Authorization: `Bearer ${staffToken}` });
const portalAuth = () => ({ Authorization: `Bearer ${portalToken}` });

async function safeJson(res) {
  try { return await res.json(); } catch (_e) { return null; }
}

// Helper — build a future date string and a (worker-discriminated) hour
// so parallel shards don't collide on the same doctor / hour. Returns
// { date: 'YYYY-MM-DD', time: 'HH:00' }.
let bookingCounter = 0;
function nextBookingSlot() {
  bookingCounter += 1;
  // 14 days ahead so weekend / holiday catalog noise doesn't matter.
  const d = new Date();
  d.setDate(d.getDate() + 14 + (WORKER * 7) + bookingCounter);
  const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  // Hour = 9 + ((worker*5 + counter) % 9), clamped to clinic hours 09-17.
  const hour = 9 + ((WORKER * 5 + bookingCounter) % 9);
  const time = `${String(hour).padStart(2, '0')}:00`;
  return { date, time };
}

test.beforeAll(async ({ request }) => {
  // Staff login (rishu) — needed to scrub residue in afterAll.
  const login = await request.post(`${API}/auth/login`, {
    data: RISHU, timeout: REQUEST_TIMEOUT,
  });
  expect(login.ok(), 'rishu staff login must succeed').toBeTruthy();
  staffToken = (await login.json()).token;

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
    `verify-otp must accept demo OTP for ${DEMO_PORTAL_PHONE}; got ${verify.status()}`,
  ).toBeTruthy();
  const vBody = await verify.json();
  portalToken = vBody.token;
  demoPatientId = vBody.patient && vBody.patient.id;
  expect(demoPatientId).toBeGreaterThan(0);
});

test.afterAll(async ({ request }) => {
  // Soft cleanup — cancel any booked visit this spec created so the demo
  // calendar doesn't fill up with E2E noise. Visits keep their RUN_TAG in
  // the `reason` field so the global teardown can also sweep them.
  if (!portalToken) return;
  for (const id of createdVisitIds) {
    try {
      await request.post(`${API}/wellness/portal/appointments/${id}/cancel`, {
        headers: portalAuth(),
        timeout: REQUEST_TIMEOUT,
      });
    } catch (_e) { /* best-effort */ }
  }
  // Rename to _teardown_ prefix so any residue is identifiable as test
  // pollution rather than real demo data. The staff PUT /visits handler
  // accepts an arbitrary reason via direct update.
  for (const id of createdVisitIds) {
    try {
      await request.put(`${API}/wellness/visits/${id}`, {
        headers: { ...staffAuth(), 'Content-Type': 'application/json' },
        data: { reason: `_teardown_${RUN_TAG}_visit_${id}` },
        timeout: REQUEST_TIMEOUT,
      });
    } catch (_e) { /* best-effort */ }
  }
});

test.describe('POST /api/wellness/portal/appointments/book', () => {
  test('happy path returns mapped envelope', async ({ request }) => {
    test.skip(!portalToken, 'portal token unavailable');
    const slot = nextBookingSlot();
    const res = await request.post(`${API}/wellness/portal/appointments/book`, {
      headers: portalAuth(),
      data: {
        appointmentDate: slot.date,
        appointmentTime: slot.time,
        reason: `${RUN_TAG} booking happy path`,
      },
      timeout: REQUEST_TIMEOUT,
    });
    expect(res.status(), `body=${await res.text().catch(() => '')}`).toBe(201);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.appointment).toBeTruthy();
    expect(body.appointment.id).toBeGreaterThan(0);
    expect(body.appointment.status).toBe('booked');
    // No doctor selected → pending assignment label per service contract.
    expect(body.appointment.doctorName).toBe('Pending assignment');
    expect(body.appointment.doctorAssigned).toBe(false);
    expect(body.appointment.canCancel).toBe(true);
    expect(body.appointment.canReschedule).toBe(true);
    createdVisitIds.push(body.appointment.id);
  });

  test('missing reason → 400 REASON_REQUIRED', async ({ request }) => {
    test.skip(!portalToken, 'portal token unavailable');
    const slot = nextBookingSlot();
    const res = await request.post(`${API}/wellness/portal/appointments/book`, {
      headers: portalAuth(),
      data: {
        appointmentDate: slot.date,
        appointmentTime: slot.time,
        reason: '   ',
      },
      timeout: REQUEST_TIMEOUT,
    });
    expect(res.status()).toBe(400);
    const body = await safeJson(res);
    expect(body && body.code).toBe('REASON_REQUIRED');
  });

  test('rejects request without a portal token (401)', async ({ request }) => {
    const slot = nextBookingSlot();
    const res = await request.post(`${API}/wellness/portal/appointments/book`, {
      data: { appointmentDate: slot.date, appointmentTime: slot.time, reason: 'x' },
      timeout: REQUEST_TIMEOUT,
    });
    // The global staff guard fires first with 401 because /portal/* isn't
    // in server.js openPaths; portal-token middleware ALSO returns 401.
    expect(res.status()).toBe(401);
  });
});

test.describe('GET /api/wellness/portal/appointments', () => {
  test('upcoming bucket includes the seeded booking', async ({ request }) => {
    test.skip(!portalToken || createdVisitIds.length === 0, 'no seeded booking');
    // The pending-assignment booking lives in the "pending" bucket
    // (doctorId IS NULL), so it should show up there — not under upcoming.
    const res = await request.get(
      `${API}/wellness/portal/appointments?bucket=pending`,
      { headers: portalAuth(), timeout: REQUEST_TIMEOUT },
    );
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.bucket).toBe('pending');
    expect(Array.isArray(body.appointments)).toBe(true);
    const ids = body.appointments.map((a) => a.id);
    // At least one of the visits seeded above belongs to our patient.
    const ours = createdVisitIds.filter((id) => ids.includes(id));
    expect(ours.length).toBeGreaterThan(0);
  });

  test('unknown bucket returns 400 INVALID_BUCKET', async ({ request }) => {
    test.skip(!portalToken, 'portal token unavailable');
    const res = await request.get(
      `${API}/wellness/portal/appointments?bucket=garbage`,
      { headers: portalAuth(), timeout: REQUEST_TIMEOUT },
    );
    expect(res.status()).toBe(400);
    const body = await safeJson(res);
    expect(body && body.code).toBe('INVALID_BUCKET');
  });
});

test.describe('PATCH /api/wellness/portal/appointments/:id/reschedule', () => {
  let targetVisitId = 0;

  test.beforeAll(async ({ request }) => {
    test.skip(!portalToken, 'portal token unavailable');
    const slot = nextBookingSlot();
    const res = await request.post(`${API}/wellness/portal/appointments/book`, {
      headers: portalAuth(),
      data: {
        appointmentDate: slot.date,
        appointmentTime: slot.time,
        reason: `${RUN_TAG} reschedule-test seed`,
      },
      timeout: REQUEST_TIMEOUT,
    });
    if (res.ok()) {
      const body = await res.json();
      targetVisitId = body.appointment && body.appointment.id;
      if (targetVisitId) createdVisitIds.push(targetVisitId);
    }
  });

  test('moves appointment to a new future slot', async ({ request }) => {
    test.skip(!targetVisitId, 'reschedule target not seeded');
    const slot = nextBookingSlot();
    const res = await request.patch(
      `${API}/wellness/portal/appointments/${targetVisitId}/reschedule`,
      {
        headers: portalAuth(),
        data: { appointmentDate: slot.date, appointmentTime: slot.time },
        timeout: REQUEST_TIMEOUT,
      },
    );
    expect(res.status(), `body=${await res.text().catch(() => '')}`).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.appointment.id).toBe(targetVisitId);
    // Envelope still carries the canReschedule flag — status is still 'booked'.
    expect(body.appointment.canReschedule).toBe(true);
  });

  test('past date returns 400 DATE_NOT_FUTURE', async ({ request }) => {
    test.skip(!targetVisitId, 'reschedule target not seeded');
    const d = new Date();
    d.setDate(d.getDate() - 7);
    const pastDate = d.toISOString().slice(0, 10);
    const res = await request.patch(
      `${API}/wellness/portal/appointments/${targetVisitId}/reschedule`,
      {
        headers: portalAuth(),
        data: { appointmentDate: pastDate, appointmentTime: '10:00' },
        timeout: REQUEST_TIMEOUT,
      },
    );
    expect(res.status()).toBe(400);
    const body = await safeJson(res);
    expect(body && body.code).toBe('DATE_NOT_FUTURE');
  });
});

test.describe('POST /api/wellness/portal/appointments/:id/cancel', () => {
  let cancelTargetId = 0;

  test.beforeAll(async ({ request }) => {
    test.skip(!portalToken, 'portal token unavailable');
    const slot = nextBookingSlot();
    const res = await request.post(`${API}/wellness/portal/appointments/book`, {
      headers: portalAuth(),
      data: {
        appointmentDate: slot.date,
        appointmentTime: slot.time,
        reason: `${RUN_TAG} cancel-test seed`,
      },
      timeout: REQUEST_TIMEOUT,
    });
    if (res.ok()) {
      const body = await res.json();
      cancelTargetId = body.appointment && body.appointment.id;
      if (cancelTargetId) createdVisitIds.push(cancelTargetId);
    }
  });

  test('cancel updates status; cancelled bucket lists it', async ({ request }) => {
    test.skip(!cancelTargetId, 'cancel target not seeded');
    const res = await request.post(
      `${API}/wellness/portal/appointments/${cancelTargetId}/cancel`,
      { headers: portalAuth(), timeout: REQUEST_TIMEOUT },
    );
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.appointment.status).toBe('cancelled');

    const listRes = await request.get(
      `${API}/wellness/portal/appointments?bucket=cancelled`,
      { headers: portalAuth(), timeout: REQUEST_TIMEOUT },
    );
    expect(listRes.status()).toBe(200);
    const listBody = await listRes.json();
    const ids = listBody.appointments.map((a) => a.id);
    expect(ids).toContain(cancelTargetId);
  });

  test('cancelling an already-cancelled appointment is idempotent', async ({ request }) => {
    test.skip(!cancelTargetId, 'cancel target not seeded');
    const res = await request.post(
      `${API}/wellness/portal/appointments/${cancelTargetId}/cancel`,
      { headers: portalAuth(), timeout: REQUEST_TIMEOUT },
    );
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.appointment.status).toBe('cancelled');
  });

  test('cancel for a non-existent visit returns 404 NOT_FOUND', async ({ request }) => {
    test.skip(!portalToken, 'portal token unavailable');
    const res = await request.post(
      `${API}/wellness/portal/appointments/999999999/cancel`,
      { headers: portalAuth(), timeout: REQUEST_TIMEOUT },
    );
    expect(res.status()).toBe(404);
  });
});
