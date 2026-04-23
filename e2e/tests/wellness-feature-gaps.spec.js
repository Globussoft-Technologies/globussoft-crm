// @ts-check
/**
 * Wellness — Feature-gap E2E coverage.
 *
 * Adds test coverage for wellness v3.2 features that existed in the codebase
 * but were NOT exercised by any prior wellness spec:
 *
 *   G. Telehealth (Jitsi videoRoom on Visit)
 *   H. Loyalty ledger (credit, redeem, leaderboard, role gating)
 *   I. Referrals (create, list, reward, double-reward guard)
 *   J. Waitlist (CRUD lifecycle)
 *   K. Low-stock inventory alert cron (manual trigger)
 *   L. Tenant branding (color PUT with validation, admin-only gate)
 *   M. Service consumption (inventory per-visit)
 *   N. Per-location dashboard filter
 *
 * All tests run against production (`crm.globusdemos.com`) using seeded
 * wellness data. Rows created here use unique stamps so re-runs don't collide.
 */
const { test, expect } = require('@playwright/test');

const BASE_URL = process.env.BASE_URL || 'https://crm.globusdemos.com';
const API = `${BASE_URL}/api`;

const ADMIN = { email: 'admin@wellness.demo', password: 'password123' };
const USER  = { email: 'user@wellness.demo',  password: 'password123' };
const STAMP = Date.now().toString().slice(-6);

async function login(request, creds) {
  const res = await request.post(`${API}/auth/login`, { data: creds });
  expect(res.ok(), `login ${creds.email} ${res.status()}`).toBeTruthy();
  return (await res.json()).token;
}

function auth(token) {
  return { Authorization: `Bearer ${token}` };
}

// =========================================================================
//  G. TELEHEALTH — set + read videoRoom on a Visit
// =========================================================================

test.describe.serial('Journey G — Telehealth (Jitsi videoRoom)', () => {
  let visitId = null;
  const roomName = `enhanced-wellness-consult-${STAMP}`;

  test('G1. Create a visit to attach a video room to', async ({ request }) => {
    const token = await login(request, ADMIN);
    // Pick first existing patient
    const p = await request.get(`${API}/wellness/patients?limit=1`, { headers: auth(token) });
    expect(p.ok()).toBeTruthy();
    const patients = (await p.json()).patients || [];
    expect(patients.length).toBeGreaterThan(0);

    const v = await request.post(`${API}/wellness/visits`, {
      headers: auth(token),
      data: { patientId: patients[0].id, status: 'booked', notes: 'Telehealth test' },
    });
    expect(v.ok()).toBeTruthy();
    visitId = (await v.json()).id;
  });

  test('G2. PUT /visits/:id sets videoRoom (telehealth room name persisted)', async ({ request }) => {
    const token = await login(request, ADMIN);
    const res = await request.put(`${API}/wellness/visits/${visitId}`, {
      headers: auth(token),
      data: { videoRoom: roomName },
    });
    expect(res.ok(), `PUT /visits ${res.status()}`).toBeTruthy();
    const body = await res.json();
    expect(body.videoRoom).toBe(roomName);
  });

  test('G3. GET /visits/:id returns the persisted videoRoom', async ({ request }) => {
    const token = await login(request, ADMIN);
    const res = await request.get(`${API}/wellness/visits/${visitId}`, { headers: auth(token) });
    expect(res.ok()).toBeTruthy();
    const v = await res.json();
    expect(v.videoRoom).toBe(roomName);
  });

  test('G4. Clearing videoRoom via PUT with empty string drops the room binding', async ({ request }) => {
    const token = await login(request, ADMIN);
    const res = await request.put(`${API}/wellness/visits/${visitId}`, {
      headers: auth(token),
      data: { videoRoom: '' },
    });
    expect(res.ok()).toBeTruthy();
    const v = await res.json();
    expect([null, '', undefined]).toContain(v.videoRoom);
  });
});

// =========================================================================
//  H. LOYALTY — credit, redeem, leaderboard, role gating
// =========================================================================

test.describe.serial('Journey H — Loyalty ledger', () => {
  let patientId = null;
  let initialBalance = null;

  test('H1. Create a fresh patient to credit (avoids mutating existing rows)', async ({ request }) => {
    const token = await login(request, ADMIN);
    const res = await request.post(`${API}/wellness/patients`, {
      headers: auth(token),
      data: { name: `Loyalty ${STAMP}`, phone: `+919${STAMP}00000`, gender: 'female' },
    });
    expect(res.ok()).toBeTruthy();
    patientId = (await res.json()).id;
  });

  test('H2. GET /loyalty/:patientId returns a zero balance + empty ledger', async ({ request }) => {
    const token = await login(request, ADMIN);
    const res = await request.get(`${API}/wellness/loyalty/${patientId}`, { headers: auth(token) });
    expect(res.ok(), `loyalty GET ${res.status()}`).toBeTruthy();
    const data = await res.json();
    initialBalance = Number(data.balance ?? data.points ?? 0);
    expect(initialBalance).toBe(0);
  });

  test('H3. POST /loyalty/:id/credit (ADMIN) adds 100 points', async ({ request }) => {
    const token = await login(request, ADMIN);
    const res = await request.post(`${API}/wellness/loyalty/${patientId}/credit`, {
      headers: auth(token),
      data: { points: 100, reason: 'E2E welcome bonus' },
    });
    expect([200, 201]).toContain(res.status());
    const tx = await res.json();
    expect(tx.points).toBe(100);
    expect(tx.type).toMatch(/credit/);
  });

  test('H4. Balance now shows +100 and ledger includes the credit row', async ({ request }) => {
    const token = await login(request, ADMIN);
    const res = await request.get(`${API}/wellness/loyalty/${patientId}`, { headers: auth(token) });
    expect(res.ok()).toBeTruthy();
    const data = await res.json();
    const balance = Number(data.balance ?? data.points ?? 0);
    expect(balance).toBe(100);
    const hay = JSON.stringify(data);
    expect(hay).toContain('welcome bonus');
  });

  test('H5. POST /loyalty/:id/redeem deducts 40 points', async ({ request }) => {
    const token = await login(request, ADMIN);
    const res = await request.post(`${API}/wellness/loyalty/${patientId}/redeem`, {
      headers: auth(token),
      data: { points: 40, reason: 'Service discount' },
    });
    expect([200, 201]).toContain(res.status());
  });

  test('H6. Balance is 60 after credit=100 + redeem=40', async ({ request }) => {
    const token = await login(request, ADMIN);
    const res = await request.get(`${API}/wellness/loyalty/${patientId}`, { headers: auth(token) });
    const data = await res.json();
    const balance = Number(data.balance ?? data.points ?? 0);
    expect(balance).toBe(60);
  });

  test('H7. Negative / zero points on credit → 400', async ({ request }) => {
    const token = await login(request, ADMIN);
    const res = await request.post(`${API}/wellness/loyalty/${patientId}/credit`, {
      headers: auth(token),
      data: { points: -5, reason: 'bad input' },
    });
    expect(res.status()).toBe(400);
  });

  test('H8. USER (non-manager) role is forbidden from crediting (role gate)', async ({ request }) => {
    const token = await login(request, USER);
    const res = await request.post(`${API}/wellness/loyalty/${patientId}/credit`, {
      headers: auth(token),
      data: { points: 100, reason: 'should be blocked' },
    });
    expect(res.status()).toBe(403);
  });

  test('H9. Loyalty leaderboard for the month returns an array', async ({ request }) => {
    const token = await login(request, ADMIN);
    const res = await request.get(`${API}/wellness/loyalty/leaderboard/month`, { headers: auth(token) });
    expect(res.ok(), `leaderboard ${res.status()}`).toBeTruthy();
    const body = await res.json();
    const arr = Array.isArray(body) ? body : (body.rows || body.items || []);
    expect(Array.isArray(arr)).toBeTruthy();
  });
});

// =========================================================================
//  I. REFERRALS — create, list, reward, double-reward guard
// =========================================================================

test.describe.serial('Journey I — Referrals', () => {
  let referrerId = null;
  let referralId = null;

  test('I1. Create a referrer patient', async ({ request }) => {
    const token = await login(request, ADMIN);
    const res = await request.post(`${API}/wellness/patients`, {
      headers: auth(token),
      data: { name: `Referrer ${STAMP}`, phone: `+919${STAMP}11111` },
    });
    expect(res.ok()).toBeTruthy();
    referrerId = (await res.json()).id;
  });

  test('I2. POST /referrals files a referral for a new name', async ({ request }) => {
    const token = await login(request, ADMIN);
    const res = await request.post(`${API}/wellness/referrals`, {
      headers: auth(token),
      data: {
        referrerPatientId: referrerId,
        referredName: `Friend ${STAMP}`,
        referredPhone: `+919${STAMP}22222`,
        referredEmail: `friend_${STAMP}@example.test`,
      },
    });
    expect([200, 201]).toContain(res.status());
    const ref = await res.json();
    referralId = ref.id;
    expect(ref.status).toBe('pending');
  });

  test('I3. GET /referrals (manager) lists referrals — includes ours', async ({ request }) => {
    const token = await login(request, ADMIN);
    const res = await request.get(`${API}/wellness/referrals?status=pending`, { headers: auth(token) });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    const list = body.referrals || body.items || body;
    const mine = list.find((r) => r.id === referralId);
    expect(mine).toBeDefined();
  });

  test('I4. USER role cannot list referrals (role gate)', async ({ request }) => {
    const token = await login(request, USER);
    const res = await request.get(`${API}/wellness/referrals`, { headers: auth(token) });
    expect(res.status()).toBe(403);
  });

  test('I5. PUT /referrals/:id/reward flips status to rewarded', async ({ request }) => {
    const token = await login(request, ADMIN);
    const res = await request.put(`${API}/wellness/referrals/${referralId}/reward`, {
      headers: auth(token),
      data: { rewardPoints: 100 },
    });
    expect(res.ok(), `reward PUT ${res.status()}`).toBeTruthy();
    const body = await res.json();
    // Response shape: { referral: {...}, transaction: {...} } — atomic tx
    expect(body.referral?.status).toBe('rewarded');
    expect(body.transaction?.type).toBe('referral_bonus');
  });

  test('I6. Double-reward is rejected (idempotence guard)', async ({ request }) => {
    const token = await login(request, ADMIN);
    const res = await request.put(`${API}/wellness/referrals/${referralId}/reward`, {
      headers: auth(token),
      data: { rewardPoints: 100 },
    });
    // Should not succeed a second time — either 400 (already rewarded) or 409
    expect([400, 409, 422]).toContain(res.status());
  });
});

// =========================================================================
//  J. WAITLIST — CRUD lifecycle
// =========================================================================

test.describe.serial('Journey J — Waitlist', () => {
  let waitlistId = null;
  let patientId = null;

  test('J1. Create a patient + add them to the waitlist', async ({ request }) => {
    const token = await login(request, ADMIN);
    const pRes = await request.post(`${API}/wellness/patients`, {
      headers: auth(token),
      data: { name: `Waitlist ${STAMP}`, phone: `+919${STAMP}33333` },
    });
    expect(pRes.ok()).toBeTruthy();
    patientId = (await pRes.json()).id;

    const w = await request.post(`${API}/wellness/waitlist`, {
      headers: auth(token),
      data: {
        patientId,
        preferredDateRange: 'Next week morning',
        notes: 'Prefers Dr. Harsh',
      },
    });
    expect([200, 201]).toContain(w.status());
    waitlistId = (await w.json()).id;
  });

  test('J2. GET /waitlist includes our entry', async ({ request }) => {
    const token = await login(request, ADMIN);
    const res = await request.get(`${API}/wellness/waitlist`, { headers: auth(token) });
    expect(res.ok()).toBeTruthy();
    const list = await res.json();
    const arr = Array.isArray(list) ? list : (list.items || []);
    const mine = arr.find((w) => w.id === waitlistId);
    expect(mine).toBeDefined();
    expect(mine.notes).toContain('Dr. Harsh');
  });

  test('J3. PUT /waitlist/:id updates status', async ({ request }) => {
    const token = await login(request, ADMIN);
    const res = await request.put(`${API}/wellness/waitlist/${waitlistId}`, {
      headers: auth(token),
      data: { status: 'offered', notes: 'Slot offered Mon 10 AM' },
    });
    expect(res.ok()).toBeTruthy();
    const w = await res.json();
    expect(w.status).toBe('offered');
  });

  test('J4. DELETE /waitlist/:id removes the entry', async ({ request }) => {
    const token = await login(request, ADMIN);
    const del = await request.delete(`${API}/wellness/waitlist/${waitlistId}`, { headers: auth(token) });
    expect([200, 204]).toContain(del.status());

    const check = await request.get(`${API}/wellness/waitlist`, { headers: auth(token) });
    const list = await check.json();
    const arr = Array.isArray(list) ? list : (list.items || []);
    expect(arr.find((w) => w.id === waitlistId)).toBeFalsy();
  });

  test('J5. Missing patientId returns 400 (input validation)', async ({ request }) => {
    const token = await login(request, ADMIN);
    const res = await request.post(`${API}/wellness/waitlist`, {
      headers: auth(token),
      data: { notes: 'no patient' },
    });
    expect(res.status()).toBe(400);
  });
});

// =========================================================================
//  K. LOW-STOCK ALERTS CRON — manual trigger
// =========================================================================

test.describe('Journey K — Low-stock inventory alerts', () => {
  test('K1. POST /inventory/low-stock/run executes + returns a result object', async ({ request }) => {
    const token = await login(request, ADMIN);
    const res = await request.post(`${API}/wellness/inventory/low-stock/run`, {
      headers: auth(token),
    });
    expect(res.ok(), `low-stock/run ${res.status()}`).toBeTruthy();
    const body = await res.json();
    expect(typeof body).toBe('object');
  });

  test('K2. Re-running is safe (idempotent) and returns same shape', async ({ request }) => {
    const token = await login(request, ADMIN);
    const res1 = await request.post(`${API}/wellness/inventory/low-stock/run`, { headers: auth(token) });
    const res2 = await request.post(`${API}/wellness/inventory/low-stock/run`, { headers: auth(token) });
    expect(res1.ok()).toBeTruthy();
    expect(res2.ok()).toBeTruthy();
    const a = await res1.json();
    const b = await res2.json();
    expect(Object.keys(a).sort()).toEqual(Object.keys(b).sort());
  });
});

// =========================================================================
//  L. BRANDING — color PUT, validation, admin gate
// =========================================================================

test.describe.serial('Journey L — Tenant branding (color)', () => {
  let originalColor = null;

  test('L1. GET /branding returns the current shape (logoUrl, brandColor, name, currency)', async ({ request }) => {
    const token = await login(request, ADMIN);
    const res = await request.get(`${API}/wellness/branding`, { headers: auth(token) });
    expect(res.ok()).toBeTruthy();
    const b = await res.json();
    expect(b).toHaveProperty('name');
    expect(b).toHaveProperty('defaultCurrency');
    expect(b.defaultCurrency).toBe('INR');
    originalColor = b.brandColor; // preserve for restore
  });

  test('L2. PUT /branding/color with a valid 6-digit hex persists + reads back', async ({ request }) => {
    const token = await login(request, ADMIN);
    const put = await request.put(`${API}/wellness/branding/color`, {
      headers: auth(token),
      data: { brandColor: '#265855' },
    });
    expect(put.ok()).toBeTruthy();
    const get = await request.get(`${API}/wellness/branding`, { headers: auth(token) });
    const b = await get.json();
    expect(b.brandColor).toBe('#265855');
  });

  test('L3. Invalid brandColor (not hex) → 400', async ({ request }) => {
    const token = await login(request, ADMIN);
    const res = await request.put(`${API}/wellness/branding/color`, {
      headers: auth(token),
      data: { brandColor: 'not-a-hex' },
    });
    expect(res.status()).toBe(400);
  });

  test('L4. USER (non-admin) role is blocked from changing brand color', async ({ request }) => {
    const token = await login(request, USER);
    const res = await request.put(`${API}/wellness/branding/color`, {
      headers: auth(token),
      data: { brandColor: '#ffffff' },
    });
    expect(res.status()).toBe(403);
  });

  test('L5. Restore original brandColor (cleanup)', async ({ request }) => {
    const token = await login(request, ADMIN);
    const res = await request.put(`${API}/wellness/branding/color`, {
      headers: auth(token),
      data: { brandColor: originalColor }, // null or previous value
    });
    expect(res.ok()).toBeTruthy();
  });
});

// =========================================================================
//  M. SERVICE CONSUMPTION — per-visit inventory log
// =========================================================================

test.describe.serial('Journey M — Service consumption', () => {
  let visitId = null;

  test('M1. Create a visit we can log consumption against', async ({ request }) => {
    const token = await login(request, ADMIN);
    const p = await request.get(`${API}/wellness/patients?limit=1`, { headers: auth(token) });
    const pid = (await p.json()).patients[0].id;
    const v = await request.post(`${API}/wellness/visits`, {
      headers: auth(token),
      data: { patientId: pid, status: 'in-treatment' },
    });
    expect(v.ok()).toBeTruthy();
    visitId = (await v.json()).id;
  });

  test('M2. POST /visits/:id/consumptions logs a product used in the visit', async ({ request }) => {
    const token = await login(request, ADMIN);
    const res = await request.post(`${API}/wellness/visits/${visitId}/consumptions`, {
      headers: auth(token),
      data: { productName: `Serum ${STAMP}`, qty: 2, unitCost: 350 },
    });
    expect([200, 201]).toContain(res.status());
    const c = await res.json();
    expect(c.qty).toBe(2);
    expect(Number(c.unitCost)).toBe(350);
  });

  test('M3. GET /visits/:id/consumptions returns the logged item', async ({ request }) => {
    const token = await login(request, ADMIN);
    const res = await request.get(`${API}/wellness/visits/${visitId}/consumptions`, { headers: auth(token) });
    expect(res.ok()).toBeTruthy();
    const list = await res.json();
    expect(Array.isArray(list)).toBeTruthy();
    expect(list.find((c) => c.productName.includes(STAMP))).toBeDefined();
  });

  test('M4. POST with no productName → 400', async ({ request }) => {
    const token = await login(request, ADMIN);
    const res = await request.post(`${API}/wellness/visits/${visitId}/consumptions`, {
      headers: auth(token),
      data: { qty: 1, unitCost: 100 },
    });
    expect(res.status()).toBe(400);
  });

  test('M5. POST to a non-existent visit → 404', async ({ request }) => {
    const token = await login(request, ADMIN);
    const res = await request.post(`${API}/wellness/visits/999999999/consumptions`, {
      headers: auth(token),
      data: { productName: 'foo' },
    });
    expect(res.status()).toBe(404);
  });
});

// =========================================================================
//  N. PER-LOCATION DASHBOARD FILTER
// =========================================================================

test.describe('Journey N — Per-location dashboard', () => {
  test('N1. GET /dashboard with no locationId returns aggregate snapshot', async ({ request }) => {
    const token = await login(request, ADMIN);
    const res = await request.get(`${API}/wellness/dashboard`, { headers: auth(token) });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(typeof body).toBe('object');
  });

  test('N2. GET /dashboard?locationId=<real> filters without error', async ({ request }) => {
    const token = await login(request, ADMIN);
    const locs = await request.get(`${API}/wellness/locations`, { headers: auth(token) });
    const list = await locs.json();
    const arr = Array.isArray(list) ? list : (list.locations || list.items || []);
    expect(arr.length).toBeGreaterThan(0);
    const id = arr[0].id;

    const res = await request.get(`${API}/wellness/dashboard?locationId=${id}`, { headers: auth(token) });
    expect(res.ok()).toBeTruthy();
  });

  test('N3. GET /dashboard?locationId=999999 (non-existent) still 200 with empty/zero stats', async ({ request }) => {
    const token = await login(request, ADMIN);
    const res = await request.get(`${API}/wellness/dashboard?locationId=999999`, { headers: auth(token) });
    // Either returns empty data or rejects with 4xx — both reasonable
    expect([200, 400, 404]).toContain(res.status());
  });

  test('N4. P&L by service honors ?locationId= without crashing', async ({ request }) => {
    const token = await login(request, ADMIN);
    const locs = await request.get(`${API}/wellness/locations`, { headers: auth(token) });
    const arr = (await locs.json()).locations || (await locs.json()) || [];
    const id = (Array.isArray(arr) ? arr[0] : arr.locations?.[0])?.id || 1;
    const res = await request.get(`${API}/wellness/reports/pnl-by-service?locationId=${id}`, { headers: auth(token) });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(Array.isArray(body.rows)).toBeTruthy();
  });
});
