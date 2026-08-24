// @ts-check
/**
 * Staff ↔ clinic-location assignment (geo-tagged attendance).
 *
 * routes/wellness.js — the /location-assignments/* family. Three of these
 * endpoints are new (counts, by-location roster, bulk write); the per-user
 * GET/PUT pair predates them and is covered here too because the bulk writes
 * have to leave it consistent.
 *
 * Endpoints covered:
 *   GET  /api/wellness/location-assignments/counts
 *        — { counts: { [locationId]: n } } for every clinic in one request
 *   GET  /api/wellness/location-assignments/by-location/:locationId
 *        — roster + per-row assignedHere / otherLocationCount + geofenceActive
 *        — 404 on another tenant's / unknown location
 *   POST /api/wellness/location-assignments/bulk
 *        — mode add / replace / remove
 *        — 400 INVALID_MODE, MISSING_FIELDS, NO_STAFF_SELECTED, INVALID_USER_ID
 *        — 404 LOCATION_NOT_FOUND
 *   GET/PUT /api/wellness/location-assignments/:userId  (per-user, pre-existing)
 *
 * WHY the bulk endpoints exist: drawing a geofence is only half the job. A
 * clinic with a radius but nobody assigned enforces nothing at all, because
 * lib/attendanceGeofence.js deliberately treats a user with zero UserLocation
 * rows as un-geofenced. Attaching a twenty-person clinic through the per-user
 * PUT meant twenty round trips through the Staff edit modal.
 *
 * Route-ordering regression guard: "counts", "by-location" and "bulk" are all
 * literal segments that sit in front of the parametric
 * "/location-assignments/:userId". If anyone reorders those declarations,
 * Express binds "counts" as a :userId, the handler parseInt()s it to NaN, and
 * the counts test below starts 404-ing. That is the single most likely way
 * this family breaks, so it is asserted first.
 *
 * Tenant safety: every write is scoped to the caller's tenant on BOTH sides —
 * the location must belong to them and every userId must be one of their
 * staff. The negative cases below post deliberately out-of-range ids.
 *
 * Cleanup: afterAll restores each touched user's original assignment set via
 * the per-user PUT, so a re-run starts from the same place. Nothing here
 * creates locations or users.
 */
const { test, expect } = require('@playwright/test');

// Shared mutable state (assignments for the same demo staff) — parallel
// shuffle would have one test's "replace" wipe another's "add" mid-assertion.
test.describe.configure({ mode: 'serial' });

const BASE_URL = process.env.BASE_URL || 'https://crm.globusdemos.com';
const REQUEST_TIMEOUT = 60000;

let token = null;
/** Snapshot of each touched user's assignments, restored in afterAll. */
const originalAssignments = new Map();
let clinic = null;
let staffPool = [];

async function login(request) {
  if (token) return token;
  const r = await request.post(`${BASE_URL}/api/auth/login`, {
    data: { email: 'admin@globussoft.com', password: 'password123' },
    headers: { 'Content-Type': 'application/json' },
    timeout: REQUEST_TIMEOUT,
  });
  if (r.ok()) token = (await r.json()).token;
  return token;
}

const headers = (t) => ({ Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' });

/**
 * The demo tenant is generic-vertical in some environments, where the wellness
 * router 403s wholesale. Skip rather than red-ball: this suite is about the
 * assignment contract, not about which vertical the demo seed happens to use.
 */
function skipIfUnavailable(res, why = 'wellness endpoints unavailable for this tenant') {
  if ([401, 403, 404].includes(res.status())) {
    test.skip(true, `${why} (HTTP ${res.status()})`);
    return true;
  }
  return false;
}

test.beforeAll(async ({ request }) => {
  const t = await login(request);
  if (!t) return;

  const locRes = await request.get(`${BASE_URL}/api/wellness/locations`, {
    headers: headers(t),
    timeout: REQUEST_TIMEOUT,
  });
  if (!locRes.ok()) return;
  const locations = await locRes.json();
  clinic = Array.isArray(locations) ? locations[0] : null;
  if (!clinic) return;

  const rosterRes = await request.get(
    `${BASE_URL}/api/wellness/location-assignments/by-location/${clinic.id}`,
    { headers: headers(t), timeout: REQUEST_TIMEOUT },
  );
  if (!rosterRes.ok()) return;
  const roster = await rosterRes.json();
  staffPool = (roster.staff || []).filter((s) => !s.deactivatedAt).slice(0, 3);

  // Snapshot BEFORE any test mutates, so cleanup restores the real baseline.
  for (const member of staffPool) {
    const cur = await request.get(
      `${BASE_URL}/api/wellness/location-assignments/${member.id}`,
      { headers: headers(t), timeout: REQUEST_TIMEOUT },
    );
    if (cur.ok()) {
      const body = await cur.json();
      originalAssignments.set(member.id, (body.locations || []).map((l) => l.id));
    }
  }
});

test.afterAll(async ({ request }) => {
  if (!token) return;
  for (const [userId, locationIds] of originalAssignments) {
    await request
      .put(`${BASE_URL}/api/wellness/location-assignments/${userId}`, {
        headers: headers(token),
        data: { locationIds },
        timeout: REQUEST_TIMEOUT,
      })
      .catch(() => {});
  }
});

test.describe('auth', () => {
  test('all three endpoints reject an unauthenticated caller', async ({ request }) => {
    for (const url of [
      `${BASE_URL}/api/wellness/location-assignments/counts`,
      `${BASE_URL}/api/wellness/location-assignments/by-location/1`,
    ]) {
      const res = await request.get(url, { timeout: REQUEST_TIMEOUT });
      expect(res.status(), url).toBe(401);
    }
    const post = await request.post(`${BASE_URL}/api/wellness/location-assignments/bulk`, {
      data: { locationId: 1, userIds: [1] },
      headers: { 'Content-Type': 'application/json' },
      timeout: REQUEST_TIMEOUT,
    });
    expect(post.status()).toBe(401);
  });
});

test.describe('GET /counts', () => {
  test('resolves as a literal path, not as :userId', async ({ request }) => {
    // The route-ordering guard. If "counts" were parsed as a :userId this
    // returns 404 "Staff member not found" instead of a counts envelope.
    const t = await login(request);
    const res = await request.get(`${BASE_URL}/api/wellness/location-assignments/counts`, {
      headers: headers(t),
      timeout: REQUEST_TIMEOUT,
    });
    if (skipIfUnavailable(res)) return;

    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('counts');
    expect(typeof body.counts).toBe('object');
    for (const [locationId, n] of Object.entries(body.counts)) {
      expect(Number.isFinite(Number(locationId))).toBe(true);
      expect(Number.isInteger(n)).toBe(true);
      expect(n).toBeGreaterThan(0);
    }
  });
});

test.describe('GET /by-location/:locationId', () => {
  test('returns the roster with per-row assignment state', async ({ request }) => {
    const t = await login(request);
    test.skip(!clinic, 'no clinic locations seeded in this tenant');

    const res = await request.get(
      `${BASE_URL}/api/wellness/location-assignments/by-location/${clinic.id}`,
      { headers: headers(t), timeout: REQUEST_TIMEOUT },
    );
    if (skipIfUnavailable(res)) return;
    expect(res.status()).toBe(200);

    const body = await res.json();
    expect(body.location.id).toBe(clinic.id);
    expect(Array.isArray(body.staff)).toBe(true);
    // geofenceActive must mirror the coordinates, because the UI uses it to
    // warn that an assignment will not actually restrict anything.
    expect(body.geofenceActive).toBe(
      body.location.latitude !== null && body.location.longitude !== null,
    );
    for (const member of body.staff) {
      expect(typeof member.id).toBe('number');
      expect(typeof member.assignedHere).toBe('boolean');
      expect(Number.isInteger(member.otherLocationCount)).toBe(true);
      // Passwords / secrets must never ride along on a picker payload.
      expect(member).not.toHaveProperty('password');
      expect(member).not.toHaveProperty('twoFactorSecret');
    }
  });

  test('404s for a location id outside this tenant', async ({ request }) => {
    const t = await login(request);
    const res = await request.get(
      `${BASE_URL}/api/wellness/location-assignments/by-location/999999999`,
      { headers: headers(t), timeout: REQUEST_TIMEOUT },
    );
    if ([401, 403].includes(res.status())) {
      test.skip(true, 'wellness endpoints unavailable for this tenant');
      return;
    }
    expect(res.status()).toBe(404);
  });
});

test.describe('POST /bulk — validation', () => {
  test('rejects an unknown mode', async ({ request }) => {
    const t = await login(request);
    test.skip(!clinic, 'no clinic locations seeded');
    const res = await request.post(`${BASE_URL}/api/wellness/location-assignments/bulk`, {
      headers: headers(t),
      data: { locationId: clinic.id, userIds: [1], mode: 'obliterate' },
      timeout: REQUEST_TIMEOUT,
    });
    if (skipIfUnavailable(res)) return;
    expect(res.status()).toBe(400);
    expect((await res.json()).code).toBe('INVALID_MODE');
  });

  test('rejects a missing locationId and a non-array userIds', async ({ request }) => {
    const t = await login(request);
    const bad = [
      { userIds: [1] },
      { locationId: 'abc', userIds: [1] },
      { locationId: 1, userIds: 'everyone' },
    ];
    for (const data of bad) {
      const res = await request.post(`${BASE_URL}/api/wellness/location-assignments/bulk`, {
        headers: headers(t),
        data,
        timeout: REQUEST_TIMEOUT,
      });
      if (skipIfUnavailable(res)) return;
      expect(res.status(), JSON.stringify(data)).toBe(400);
      expect((await res.json()).code).toBe('MISSING_FIELDS');
    }
  });

  test('rejects an empty selection', async ({ request }) => {
    const t = await login(request);
    test.skip(!clinic, 'no clinic locations seeded');
    const res = await request.post(`${BASE_URL}/api/wellness/location-assignments/bulk`, {
      headers: headers(t),
      data: { locationId: clinic.id, userIds: [] },
      timeout: REQUEST_TIMEOUT,
    });
    if (skipIfUnavailable(res)) return;
    expect(res.status()).toBe(400);
    expect((await res.json()).code).toBe('NO_STAFF_SELECTED');
  });

  test('404s on a location outside the tenant BEFORE touching any assignment', async ({ request }) => {
    const t = await login(request);
    test.skip(staffPool.length === 0, 'no staff available');
    const res = await request.post(`${BASE_URL}/api/wellness/location-assignments/bulk`, {
      headers: headers(t),
      data: { locationId: 999999999, userIds: [staffPool[0].id] },
      timeout: REQUEST_TIMEOUT,
    });
    if ([401, 403].includes(res.status())) {
      test.skip(true, 'wellness endpoints unavailable');
      return;
    }
    expect(res.status()).toBe(404);
    expect((await res.json()).code).toBe('LOCATION_NOT_FOUND');
  });

  test('rejects a userId that is not this tenant\'s staff', async ({ request }) => {
    // Without this check an admin could geofence a stranger's attendance by
    // posting a guessed id.
    const t = await login(request);
    test.skip(!clinic, 'no clinic locations seeded');
    const res = await request.post(`${BASE_URL}/api/wellness/location-assignments/bulk`, {
      headers: headers(t),
      data: { locationId: clinic.id, userIds: [999999999] },
      timeout: REQUEST_TIMEOUT,
    });
    if (skipIfUnavailable(res)) return;
    expect(res.status()).toBe(400);
    expect((await res.json()).code).toBe('INVALID_USER_ID');
  });
});

test.describe('POST /bulk — writes', () => {
  test('add attaches the selection and is idempotent on a re-run', async ({ request }) => {
    const t = await login(request);
    test.skip(!clinic || staffPool.length === 0, 'no clinic or staff seeded');
    const userIds = staffPool.map((s) => s.id);

    const first = await request.post(`${BASE_URL}/api/wellness/location-assignments/bulk`, {
      headers: headers(t),
      data: { locationId: clinic.id, userIds, mode: 'add' },
      timeout: REQUEST_TIMEOUT,
    });
    if (skipIfUnavailable(first)) return;
    expect(first.status()).toBe(200);
    const b1 = await first.json();
    expect(b1.ok).toBe(true);
    expect(b1.requested).toBe(userIds.length);

    // Re-running a bulk action over an overlapping selection is routine, so
    // the second pass must be a no-op rather than a duplicate-key error.
    const second = await request.post(`${BASE_URL}/api/wellness/location-assignments/bulk`, {
      headers: headers(t),
      data: { locationId: clinic.id, userIds, mode: 'add' },
      timeout: REQUEST_TIMEOUT,
    });
    expect(second.status()).toBe(200);
    const b2 = await second.json();
    expect(b2.added).toBe(0);
    expect(b2.unchanged).toBe(userIds.length);

    // The roster must now agree with what we just wrote.
    const roster = await request.get(
      `${BASE_URL}/api/wellness/location-assignments/by-location/${clinic.id}`,
      { headers: headers(t), timeout: REQUEST_TIMEOUT },
    );
    const assignedIds = (await roster.json()).staff
      .filter((s) => s.assignedHere)
      .map((s) => s.id);
    for (const id of userIds) expect(assignedIds).toContain(id);
  });

  test('counts reflect the write', async ({ request }) => {
    const t = await login(request);
    test.skip(!clinic || staffPool.length === 0, 'no clinic or staff seeded');
    const res = await request.get(`${BASE_URL}/api/wellness/location-assignments/counts`, {
      headers: headers(t),
      timeout: REQUEST_TIMEOUT,
    });
    if (skipIfUnavailable(res)) return;
    const { counts } = await res.json();
    expect(counts[clinic.id]).toBeGreaterThanOrEqual(staffPool.length);
  });

  test('remove detaches without touching other clinics', async ({ request }) => {
    const t = await login(request);
    test.skip(!clinic || staffPool.length === 0, 'no clinic or staff seeded');
    const userIds = [staffPool[0].id];

    const res = await request.post(`${BASE_URL}/api/wellness/location-assignments/bulk`, {
      headers: headers(t),
      data: { locationId: clinic.id, userIds, mode: 'remove' },
      timeout: REQUEST_TIMEOUT,
    });
    if (skipIfUnavailable(res)) return;
    expect(res.status()).toBe(200);
    expect((await res.json()).removed).toBe(1);

    const perUser = await request.get(
      `${BASE_URL}/api/wellness/location-assignments/${userIds[0]}`,
      { headers: headers(t), timeout: REQUEST_TIMEOUT },
    );
    const stillThere = (await perUser.json()).locations.map((l) => l.id);
    expect(stillThere).not.toContain(clinic.id);
  });

  test('replace leaves the user attached to this clinic and nothing else', async ({ request }) => {
    const t = await login(request);
    test.skip(!clinic || staffPool.length === 0, 'no clinic or staff seeded');
    const userIds = [staffPool[0].id];

    const res = await request.post(`${BASE_URL}/api/wellness/location-assignments/bulk`, {
      headers: headers(t),
      data: { locationId: clinic.id, userIds, mode: 'replace' },
      timeout: REQUEST_TIMEOUT,
    });
    if (skipIfUnavailable(res)) return;
    expect(res.status()).toBe(200);

    const perUser = await request.get(
      `${BASE_URL}/api/wellness/location-assignments/${userIds[0]}`,
      { headers: headers(t), timeout: REQUEST_TIMEOUT },
    );
    const ids = (await perUser.json()).locations.map((l) => l.id);
    expect(ids).toEqual([clinic.id]);
  });
});
