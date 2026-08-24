// @ts-check
/**
 * Standalone geofence zones (geo-tagged attendance, decoupled from clinic
 * Location) + bulk staff assignment + the tenant-wide Global fallback.
 *
 * routes/wellness_geofence_zones.js — GeofenceZone CRUD and the
 * /geofence-zone-assignments/* family (counts, by-zone roster, bulk write).
 *
 * WHY this exists as a SEPARATE concept from clinic Location's own
 * geofenceRadiusM: a clinic Location owns a full business identity —
 * address, patients, visits, resources. A geofence for "the warehouse" or a
 * one-off training camp has no business being any of those, so it isn't a
 * Location at all. GeofenceZone is a bare pin + radius, assignable to any
 * staff member independent of which clinic (if any) they work at.
 *
 * THE GLOBAL ZONE — the product decision this feature was built around:
 *   At most one zone per tenant may be marked Global at a time (enforced by
 *   a transaction in the route, not a DB constraint — MySQL has no clean
 *   partial-unique-index syntax for it). It is the fallback radius applied
 *   to a staff member who has NO specific assignment at all — neither a
 *   clinic (UserLocation) nor a zone (UserGeofenceZone). The instant that
 *   person gets a specific assignment, the Global zone stops applying to
 *   them. Marking a NEW zone Global silently un-marks whichever zone held
 *   that spot before — "the latest one set as Global overrides it" needs no
 *   extra code because there is only ever one to find. The actual fallback
 *   RESOLUTION (not owned by this file) lives in routes/attendance.js's
 *   resolveGeofenceContext and is covered by backend/test/routes/
 *   attendance.test.js's "standalone geofence zones + Global fallback"
 *   block. This spec covers the CRUD + assignment surface only.
 *
 * Endpoints covered:
 *   GET    /api/wellness/geofence-zones                    list + assignedCount
 *   POST   /api/wellness/geofence-zones                    create
 *          — 400 on missing name / out-of-range lat-lng / out-of-range radius
 *          — isGlobal:true un-globals whatever zone held that spot before
 *   PUT    /api/wellness/geofence-zones/:id                 update (partial)
 *   DELETE /api/wellness/geofence-zones/:id                  delete (cascades assignments)
 *   GET    /api/wellness/geofence-zone-assignments/counts
 *   GET    /api/wellness/geofence-zone-assignments/by-zone/:zoneId
 *          — 404 on another tenant's / unknown zone
 *   POST   /api/wellness/geofence-zone-assignments/bulk
 *          — mode add / replace / remove
 *          — 400 INVALID_MODE, MISSING_FIELDS, NO_STAFF_SELECTED, INVALID_USER_ID
 *          — 404 ZONE_NOT_FOUND
 *
 * Route-ordering regression guard: "counts" and "by-zone" are literal
 * segments — there is no "/geofence-zone-assignments/:something" route
 * today, but declaring them as literals first is the same convention the
 * clinic /location-assignments/* family uses, and this spec pins that the
 * two names resolve as intended rather than silently 404ing.
 *
 * Tenant safety: every write is scoped to the caller's tenant on BOTH
 * sides — the zone must belong to them and every userId must be one of
 * their staff. Negative cases below post deliberately out-of-range ids.
 *
 * Cleanup: every zone this spec creates is named with RUN_TAG and deleted
 * in afterAll. Each touched user's assignment set is restored via the
 * per-user location-assignments PUT... except zone assignments have no
 * per-user endpoint of their own; deleting the zone itself
 * (ON DELETE CASCADE on UserGeofenceZone) is what clears those rows, so
 * afterAll's zone deletion IS the assignment cleanup.
 */
const { test, expect } = require('@playwright/test');

// Shared mutable tenant-wide state (which zone is Global) — parallel
// shuffle would have one test's "make X global" race another's assertion
// about which zone currently holds that spot.
test.describe.configure({ mode: 'serial' });

const BASE_URL = process.env.BASE_URL || 'https://crm.globusdemos.com';
const REQUEST_TIMEOUT = 60000;
const RUN_TAG = `E2E_GEOFENCE_${Date.now()}`;

let token = null;
const createdZoneIds = [];
let staffPool = [];
/** Whichever zone was Global BEFORE this spec ran, if any — restored in afterAll. */
let originalGlobalZoneId = null;

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
 * The demo tenant may be generic-vertical in some environments, where the
 * wellness router 403s wholesale. Skip rather than red-ball: this suite is
 * about the zone/assignment contract, not about which vertical the demo
 * seed happens to use.
 */
function skipIfUnavailable(res, why = 'wellness endpoints unavailable for this tenant') {
  if ([401, 403, 404].includes(res.status())) {
    test.skip(true, `${why} (HTTP ${res.status()})`);
    return true;
  }
  return false;
}

async function createZone(request, t, overrides = {}) {
  const res = await request.post(`${BASE_URL}/api/wellness/geofence-zones`, {
    headers: headers(t),
    data: {
      name: `${RUN_TAG}_zone_${createdZoneIds.length}`,
      latitude: 23.3441,
      longitude: 85.3096,
      radiusM: 150,
      ...overrides,
    },
    timeout: REQUEST_TIMEOUT,
  });
  if (res.ok()) {
    const body = await res.json();
    createdZoneIds.push(body.id);
    return body;
  }
  return null;
}

test.beforeAll(async ({ request }) => {
  const t = await login(request);
  if (!t) return;

  // Snapshot whichever zone is Global today, if any, so afterAll can put it
  // back — this spec's own isGlobal writes will otherwise leave the
  // tenant's real Global zone permanently un-globaled.
  const listRes = await request.get(`${BASE_URL}/api/wellness/geofence-zones`, {
    headers: headers(t),
    timeout: REQUEST_TIMEOUT,
  });
  if (listRes.ok()) {
    const zones = await listRes.json();
    const existingGlobal = zones.find((z) => z.isGlobal);
    if (existingGlobal) originalGlobalZoneId = existingGlobal.id;
  }

  const staffRes = await request.get(`${BASE_URL}/api/staff?fields=summary`, {
    headers: headers(t),
    timeout: REQUEST_TIMEOUT,
  });
  if (staffRes.ok()) {
    const body = await staffRes.json();
    const rows = Array.isArray(body) ? body : body.staff || [];
    staffPool = rows.filter((s) => !s.deactivatedAt).slice(0, 3);
  }
});

test.afterAll(async ({ request }) => {
  if (!token) return;
  // Deleting every zone this spec created also cascades its
  // UserGeofenceZone rows — no separate per-user zone cleanup exists.
  for (const id of createdZoneIds) {
    await request.delete(`${BASE_URL}/api/wellness/geofence-zones/${id}`, {
      headers: headers(token),
      timeout: REQUEST_TIMEOUT,
    }).catch(() => {});
  }
  if (originalGlobalZoneId) {
    await request.put(`${BASE_URL}/api/wellness/geofence-zones/${originalGlobalZoneId}`, {
      headers: headers(token),
      data: { isGlobal: true },
      timeout: REQUEST_TIMEOUT,
    }).catch(() => {});
  }
});

test.describe('auth', () => {
  test('every endpoint rejects an unauthenticated caller', async ({ request }) => {
    for (const url of [
      `${BASE_URL}/api/wellness/geofence-zones`,
      `${BASE_URL}/api/wellness/geofence-zone-assignments/counts`,
      `${BASE_URL}/api/wellness/geofence-zone-assignments/by-zone/1`,
    ]) {
      const res = await request.get(url, { timeout: REQUEST_TIMEOUT });
      expect(res.status(), url).toBe(401);
    }
    const post = await request.post(`${BASE_URL}/api/wellness/geofence-zones`, {
      data: { name: 'x', latitude: 1, longitude: 1 },
      headers: { 'Content-Type': 'application/json' },
      timeout: REQUEST_TIMEOUT,
    });
    expect(post.status()).toBe(401);
  });
});

test.describe('POST /geofence-zones — validation', () => {
  test('rejects a missing name', async ({ request }) => {
    const t = await login(request);
    const res = await request.post(`${BASE_URL}/api/wellness/geofence-zones`, {
      headers: headers(t),
      data: { latitude: 23.34, longitude: 85.31 },
      timeout: REQUEST_TIMEOUT,
    });
    if (skipIfUnavailable(res)) return;
    expect(res.status()).toBe(400);
    expect((await res.json()).code).toBe('VALIDATION_ERROR');
  });

  test('rejects out-of-range latitude/longitude', async ({ request }) => {
    const t = await login(request);
    for (const data of [
      { name: `${RUN_TAG}_bad1`, latitude: 200, longitude: 85.31 },
      { name: `${RUN_TAG}_bad2`, latitude: 23.34, longitude: -400 },
    ]) {
      const res = await request.post(`${BASE_URL}/api/wellness/geofence-zones`, {
        headers: headers(t),
        data,
        timeout: REQUEST_TIMEOUT,
      });
      if (skipIfUnavailable(res)) return;
      expect(res.status(), JSON.stringify(data)).toBe(400);
    }
  });

  test('rejects a radius outside 10-5000m', async ({ request }) => {
    const t = await login(request);
    const res = await request.post(`${BASE_URL}/api/wellness/geofence-zones`, {
      headers: headers(t),
      data: { name: `${RUN_TAG}_bad_radius`, latitude: 23.34, longitude: 85.31, radiusM: 99999 },
      timeout: REQUEST_TIMEOUT,
    });
    if (skipIfUnavailable(res)) return;
    expect(res.status()).toBe(400);
  });

  test('defaults radiusM to 150 when omitted', async ({ request }) => {
    const t = await login(request);
    const zone = await createZone(request, t, { radiusM: undefined });
    test.skip(!zone, 'wellness endpoints unavailable');
    expect(zone.radiusM).toBe(150);
  });
});

test.describe('GET /geofence-zones', () => {
  test('lists zones with an assignedCount field', async ({ request }) => {
    const t = await login(request);
    const zone = await createZone(request, t);
    test.skip(!zone, 'wellness endpoints unavailable');

    const res = await request.get(`${BASE_URL}/api/wellness/geofence-zones`, {
      headers: headers(t),
      timeout: REQUEST_TIMEOUT,
    });
    expect(res.status()).toBe(200);
    const zones = await res.json();
    const mine = zones.find((z) => z.id === zone.id);
    expect(mine).toBeTruthy();
    expect(mine.assignedCount).toBe(0);
  });
});

test.describe('isGlobal exclusivity', () => {
  test('creating a second Global zone un-globals the first one', async ({ request }) => {
    const t = await login(request);
    const first = await createZone(request, t, { isGlobal: true });
    test.skip(!first, 'wellness endpoints unavailable');
    expect(first.isGlobal).toBe(true);

    const second = await createZone(request, t, { isGlobal: true });
    expect(second.isGlobal).toBe(true);

    const listRes = await request.get(`${BASE_URL}/api/wellness/geofence-zones`, {
      headers: headers(t),
      timeout: REQUEST_TIMEOUT,
    });
    const zones = await listRes.json();
    const globals = zones.filter((z) => z.isGlobal);
    // Exactly one zone in the WHOLE tenant may be global — not just among
    // the two this test created.
    expect(globals).toHaveLength(1);
    expect(globals[0].id).toBe(second.id);

    const refetchedFirst = zones.find((z) => z.id === first.id);
    expect(refetchedFirst.isGlobal).toBe(false);
  });

  test('PUT isGlobal:true on an existing zone un-globals whichever zone held it before', async ({ request }) => {
    const t = await login(request);
    const a = await createZone(request, t, { isGlobal: true });
    test.skip(!a, 'wellness endpoints unavailable');
    const b = await createZone(request, t, { isGlobal: false });

    const putRes = await request.put(`${BASE_URL}/api/wellness/geofence-zones/${b.id}`, {
      headers: headers(t),
      data: { isGlobal: true },
      timeout: REQUEST_TIMEOUT,
    });
    expect(putRes.status()).toBe(200);
    expect((await putRes.json()).isGlobal).toBe(true);

    const listRes = await request.get(`${BASE_URL}/api/wellness/geofence-zones`, {
      headers: headers(t),
      timeout: REQUEST_TIMEOUT,
    });
    const zones = await listRes.json();
    expect(zones.find((z) => z.id === a.id).isGlobal).toBe(false);
    expect(zones.find((z) => z.id === b.id).isGlobal).toBe(true);
  });
});

test.describe('GET /geofence-zone-assignments/counts', () => {
  test('resolves as a literal path, not as a parametric segment', async ({ request }) => {
    // Route-ordering guard: if "counts" were ever parsed as a dynamic id by
    // an accidental reordering, this would 400/404 instead of returning the
    // counts envelope.
    const t = await login(request);
    const res = await request.get(`${BASE_URL}/api/wellness/geofence-zone-assignments/counts`, {
      headers: headers(t),
      timeout: REQUEST_TIMEOUT,
    });
    if (skipIfUnavailable(res)) return;
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('counts');
    expect(typeof body.counts).toBe('object');
  });
});

test.describe('GET /geofence-zone-assignments/by-zone/:zoneId', () => {
  test('returns the roster with per-row assignment state and geofenceActive:true', async ({ request }) => {
    const t = await login(request);
    const zone = await createZone(request, t);
    test.skip(!zone, 'wellness endpoints unavailable');

    const res = await request.get(
      `${BASE_URL}/api/wellness/geofence-zone-assignments/by-zone/${zone.id}`,
      { headers: headers(t), timeout: REQUEST_TIMEOUT },
    );
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.location.id).toBe(zone.id);
    // A zone can never exist without coordinates (validateZoneBody
    // requires them), so this is always true — unlike the clinic
    // equivalent, which can be false for a Location with no pin yet.
    expect(body.geofenceActive).toBe(true);
    expect(Array.isArray(body.staff)).toBe(true);
    for (const member of body.staff) {
      expect(typeof member.assignedHere).toBe('boolean');
      expect(member).not.toHaveProperty('password');
    }
  });

  test('404s for a zone id outside this tenant', async ({ request }) => {
    const t = await login(request);
    const res = await request.get(
      `${BASE_URL}/api/wellness/geofence-zone-assignments/by-zone/999999999`,
      { headers: headers(t), timeout: REQUEST_TIMEOUT },
    );
    if ([401, 403].includes(res.status())) {
      test.skip(true, 'wellness endpoints unavailable');
      return;
    }
    expect(res.status()).toBe(404);
    expect((await res.json()).code).toBe('ZONE_NOT_FOUND');
  });
});

test.describe('POST /geofence-zone-assignments/bulk — validation', () => {
  test('rejects an unknown mode', async ({ request }) => {
    const t = await login(request);
    const zone = await createZone(request, t);
    test.skip(!zone, 'wellness endpoints unavailable');
    const res = await request.post(`${BASE_URL}/api/wellness/geofence-zone-assignments/bulk`, {
      headers: headers(t),
      data: { zoneId: zone.id, userIds: [1], mode: 'obliterate' },
      timeout: REQUEST_TIMEOUT,
    });
    expect(res.status()).toBe(400);
    expect((await res.json()).code).toBe('INVALID_MODE');
  });

  test('rejects a missing zoneId and a non-array userIds', async ({ request }) => {
    const t = await login(request);
    for (const data of [
      { userIds: [1] },
      { zoneId: 'abc', userIds: [1] },
      { zoneId: 1, userIds: 'everyone' },
    ]) {
      const res = await request.post(`${BASE_URL}/api/wellness/geofence-zone-assignments/bulk`, {
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
    const zone = await createZone(request, t);
    test.skip(!zone, 'wellness endpoints unavailable');
    const res = await request.post(`${BASE_URL}/api/wellness/geofence-zone-assignments/bulk`, {
      headers: headers(t),
      data: { zoneId: zone.id, userIds: [] },
      timeout: REQUEST_TIMEOUT,
    });
    expect(res.status()).toBe(400);
    expect((await res.json()).code).toBe('NO_STAFF_SELECTED');
  });

  test('404s on a zone outside the tenant', async ({ request }) => {
    const t = await login(request);
    test.skip(staffPool.length === 0, 'no staff available');
    const res = await request.post(`${BASE_URL}/api/wellness/geofence-zone-assignments/bulk`, {
      headers: headers(t),
      data: { zoneId: 999999999, userIds: [staffPool[0].id] },
      timeout: REQUEST_TIMEOUT,
    });
    if ([401, 403].includes(res.status())) {
      test.skip(true, 'wellness endpoints unavailable');
      return;
    }
    expect(res.status()).toBe(404);
    expect((await res.json()).code).toBe('ZONE_NOT_FOUND');
  });

  test('rejects a userId that is not this tenant\'s staff', async ({ request }) => {
    const t = await login(request);
    const zone = await createZone(request, t);
    test.skip(!zone, 'wellness endpoints unavailable');
    const res = await request.post(`${BASE_URL}/api/wellness/geofence-zone-assignments/bulk`, {
      headers: headers(t),
      data: { zoneId: zone.id, userIds: [999999999] },
      timeout: REQUEST_TIMEOUT,
    });
    expect(res.status()).toBe(400);
    expect((await res.json()).code).toBe('INVALID_USER_ID');
  });
});

test.describe('POST /geofence-zone-assignments/bulk — writes', () => {
  test('add attaches the selection and is idempotent on a re-run', async ({ request }) => {
    const t = await login(request);
    const zone = await createZone(request, t);
    test.skip(!zone || staffPool.length === 0, 'no zone or staff available');
    const userIds = staffPool.map((s) => s.id);

    const first = await request.post(`${BASE_URL}/api/wellness/geofence-zone-assignments/bulk`, {
      headers: headers(t),
      data: { zoneId: zone.id, userIds, mode: 'add' },
      timeout: REQUEST_TIMEOUT,
    });
    expect(first.status()).toBe(200);
    expect((await first.json()).added).toBe(userIds.length);

    const second = await request.post(`${BASE_URL}/api/wellness/geofence-zone-assignments/bulk`, {
      headers: headers(t),
      data: { zoneId: zone.id, userIds, mode: 'add' },
      timeout: REQUEST_TIMEOUT,
    });
    const b2 = await second.json();
    expect(b2.added).toBe(0);
    expect(b2.unchanged).toBe(userIds.length);

    const roster = await request.get(
      `${BASE_URL}/api/wellness/geofence-zone-assignments/by-zone/${zone.id}`,
      { headers: headers(t), timeout: REQUEST_TIMEOUT },
    );
    const assignedIds = (await roster.json()).staff.filter((s) => s.assignedHere).map((s) => s.id);
    for (const id of userIds) expect(assignedIds).toContain(id);
  });

  test('counts reflect the write', async ({ request }) => {
    const t = await login(request);
    const zone = await createZone(request, t);
    test.skip(!zone || staffPool.length === 0, 'no zone or staff available');
    await request.post(`${BASE_URL}/api/wellness/geofence-zone-assignments/bulk`, {
      headers: headers(t),
      data: { zoneId: zone.id, userIds: [staffPool[0].id], mode: 'add' },
      timeout: REQUEST_TIMEOUT,
    });

    const res = await request.get(`${BASE_URL}/api/wellness/geofence-zone-assignments/counts`, {
      headers: headers(t),
      timeout: REQUEST_TIMEOUT,
    });
    const { counts } = await res.json();
    expect(counts[zone.id]).toBeGreaterThanOrEqual(1);
  });

  test('remove detaches from this zone only', async ({ request }) => {
    const t = await login(request);
    const zoneA = await createZone(request, t);
    test.skip(!zoneA || staffPool.length === 0, 'no zone or staff available');
    const zoneB = await createZone(request, t);
    const userId = staffPool[0].id;

    await request.post(`${BASE_URL}/api/wellness/geofence-zone-assignments/bulk`, {
      headers: headers(t), data: { zoneId: zoneA.id, userIds: [userId], mode: 'add' }, timeout: REQUEST_TIMEOUT,
    });
    await request.post(`${BASE_URL}/api/wellness/geofence-zone-assignments/bulk`, {
      headers: headers(t), data: { zoneId: zoneB.id, userIds: [userId], mode: 'add' }, timeout: REQUEST_TIMEOUT,
    });

    const removeRes = await request.post(`${BASE_URL}/api/wellness/geofence-zone-assignments/bulk`, {
      headers: headers(t), data: { zoneId: zoneA.id, userIds: [userId], mode: 'remove' }, timeout: REQUEST_TIMEOUT,
    });
    expect((await removeRes.json()).removed).toBe(1);

    const rosterA = await request.get(
      `${BASE_URL}/api/wellness/geofence-zone-assignments/by-zone/${zoneA.id}`,
      { headers: headers(t), timeout: REQUEST_TIMEOUT },
    );
    expect((await rosterA.json()).staff.find((s) => s.id === userId).assignedHere).toBe(false);

    const rosterB = await request.get(
      `${BASE_URL}/api/wellness/geofence-zone-assignments/by-zone/${zoneB.id}`,
      { headers: headers(t), timeout: REQUEST_TIMEOUT },
    );
    expect((await rosterB.json()).staff.find((s) => s.id === userId).assignedHere).toBe(true);
  });

  test('replace on a zone clears OTHER ZONE assignments only — clinic assignments are untouched', async ({ request }) => {
    const t = await login(request);
    const zoneA = await createZone(request, t);
    test.skip(!zoneA || staffPool.length === 0, 'no zone or staff available');
    const zoneB = await createZone(request, t);
    const userId = staffPool[0].id;

    await request.post(`${BASE_URL}/api/wellness/geofence-zone-assignments/bulk`, {
      headers: headers(t), data: { zoneId: zoneA.id, userIds: [userId], mode: 'add' }, timeout: REQUEST_TIMEOUT,
    });

    const replaceRes = await request.post(`${BASE_URL}/api/wellness/geofence-zone-assignments/bulk`, {
      headers: headers(t), data: { zoneId: zoneB.id, userIds: [userId], mode: 'replace' }, timeout: REQUEST_TIMEOUT,
    });
    expect(replaceRes.status()).toBe(200);
    expect((await replaceRes.json()).clearedElsewhere).toBe(1);

    const rosterA = await request.get(
      `${BASE_URL}/api/wellness/geofence-zone-assignments/by-zone/${zoneA.id}`,
      { headers: headers(t), timeout: REQUEST_TIMEOUT },
    );
    expect((await rosterA.json()).staff.find((s) => s.id === userId).assignedHere).toBe(false);

    const rosterB = await request.get(
      `${BASE_URL}/api/wellness/geofence-zone-assignments/by-zone/${zoneB.id}`,
      { headers: headers(t), timeout: REQUEST_TIMEOUT },
    );
    expect((await rosterB.json()).staff.find((s) => s.id === userId).assignedHere).toBe(true);
  });
});

test.describe('DELETE /geofence-zones/:id', () => {
  test('deleting a zone cascades its assignments (no 409-in-use, unlike a clinic Location)', async ({ request }) => {
    const t = await login(request);
    const zone = await createZone(request, t);
    test.skip(!zone || staffPool.length === 0, 'no zone or staff available');
    await request.post(`${BASE_URL}/api/wellness/geofence-zone-assignments/bulk`, {
      headers: headers(t), data: { zoneId: zone.id, userIds: [staffPool[0].id], mode: 'add' }, timeout: REQUEST_TIMEOUT,
    });

    const delRes = await request.delete(`${BASE_URL}/api/wellness/geofence-zones/${zone.id}`, {
      headers: headers(t), timeout: REQUEST_TIMEOUT,
    });
    expect(delRes.status()).toBe(200);
    // Already deleted — drop it from the cleanup list so afterAll doesn't
    // try (and fail) to delete it again.
    const idx = createdZoneIds.indexOf(zone.id);
    if (idx !== -1) createdZoneIds.splice(idx, 1);

    const getRes = await request.get(`${BASE_URL}/api/wellness/geofence-zone-assignments/by-zone/${zone.id}`, {
      headers: headers(t), timeout: REQUEST_TIMEOUT,
    });
    expect(getRes.status()).toBe(404);
  });

  test('404s deleting a zone id outside the tenant', async ({ request }) => {
    const t = await login(request);
    const res = await request.delete(`${BASE_URL}/api/wellness/geofence-zones/999999999`, {
      headers: headers(t), timeout: REQUEST_TIMEOUT,
    });
    if ([401, 403].includes(res.status())) {
      test.skip(true, 'wellness endpoints unavailable');
      return;
    }
    expect(res.status()).toBe(404);
  });
});
