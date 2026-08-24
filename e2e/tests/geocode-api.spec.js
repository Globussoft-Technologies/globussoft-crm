// @ts-check
/**
 * Geocode module — GET /api/geocode (routes/geocode.js + lib/geocodeProxy.js).
 *
 * WHY this route exists: the wellness clinic geofence picker
 * (frontend/src/components/GeofencePicker.jsx) needs "type a place name, get
 * coordinates". A geocode proxy already lived at /api/travel/pois/geocode,
 * but under the travel namespace — a wellness tenant calling it would break
 * the day anyone bolts `requireTravelTenant` onto that router. This mount is
 * the vertical-neutral surface; both routes delegate to lib/geocodeProxy.js.
 *
 * Endpoints covered:
 *   GET /api/geocode?q=...                   — auth + { results: [...] } shape
 *   GET /api/geocode?q=...&limit=N           — limit is honoured + clamped
 *   GET /api/geocode?q=...&bbox=...          — region filter narrows results
 *   GET /api/geocode?reverse=1&lat=&lng=     — { lat, lng, display_name }
 *   GET /api/geocode                         — 400 MISSING_FIELDS (no q)
 *   GET /api/geocode?reverse=1               — 400 MISSING_FIELDS (no coords)
 *   GET /api/geocode (no token)              — 401
 *
 * Upstream dependency — READ THIS BEFORE DEBUGGING A RED RUN:
 *   The route proxies photon.komoot.io, a free community-run geocoder with no
 *   API key and no SLA. When it is down or rate-limiting, the route returns
 *   502 GEOCODE_UPSTREAM_ERROR by design — that is correct behaviour, not a
 *   regression in our code. Every test below therefore treats 502 as an
 *   acceptable outcome and skips its content assertions, so a third party's
 *   bad afternoon cannot red-ball the deploy gate. What is asserted
 *   unconditionally is what WE own: auth, validation, status codes, and the
 *   response envelope shape when a 200 does come back.
 *
 * No cleanup needed: this route is read-only and writes nothing to the DB.
 */
const { test, expect } = require('@playwright/test');

const BASE_URL = process.env.BASE_URL || 'https://crm.globusdemos.com';
const REQUEST_TIMEOUT = 60000;

// Rough bounding box for India — the same default GeofencePicker sends.
const INDIA_BBOX = '68.1,6.5,97.4,35.7';

let adminToken = null;

async function loginAs(request, email, password) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await request.post(`${BASE_URL}/api/auth/login`, {
        data: { email, password },
        headers: { 'Content-Type': 'application/json' },
        timeout: REQUEST_TIMEOUT,
      });
      if (r.ok()) {
        const j = await r.json();
        return { token: j.token, userId: j.user.id };
      }
    } catch (e) {
      if (attempt === 0) continue;
    }
  }
  return { token: null, userId: null };
}

async function getAdmin(request) {
  if (!adminToken) {
    const r = await loginAs(request, 'admin@globussoft.com', 'password123');
    adminToken = r.token;
  }
  return adminToken;
}

const headers = (token) => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' });

/** True when the response is an upstream-geocoder outage rather than our bug. */
function isUpstreamOutage(res) {
  return res.status() === 502;
}

test.describe('GET /api/geocode — auth', () => {
  test('401s without a bearer token', async ({ request }) => {
    const res = await request.get(`${BASE_URL}/api/geocode?q=ranchi`, {
      timeout: REQUEST_TIMEOUT,
    });
    expect(res.status()).toBe(401);
  });

  test('is reachable by any signed-in staff user (no RBAC gate)', async ({ request }) => {
    // Deliberate: the route reads a public OSM-derived dataset and writes
    // nothing, so gating it behind a permission would only stop reps from
    // pinning their own clinic.
    const token = await getAdmin(request);
    const res = await request.get(`${BASE_URL}/api/geocode?q=ranchi`, {
      headers: headers(token),
      timeout: REQUEST_TIMEOUT,
    });
    expect([200, 502]).toContain(res.status());
  });
});

test.describe('GET /api/geocode — validation', () => {
  test('400 MISSING_FIELDS when q is absent', async ({ request }) => {
    const token = await getAdmin(request);
    const res = await request.get(`${BASE_URL}/api/geocode`, {
      headers: headers(token),
      timeout: REQUEST_TIMEOUT,
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('MISSING_FIELDS');
  });

  test('400 MISSING_FIELDS when q is whitespace only', async ({ request }) => {
    const token = await getAdmin(request);
    const res = await request.get(`${BASE_URL}/api/geocode?q=%20%20`, {
      headers: headers(token),
      timeout: REQUEST_TIMEOUT,
    });
    expect(res.status()).toBe(400);
    expect((await res.json()).code).toBe('MISSING_FIELDS');
  });

  test('400 MISSING_FIELDS on reverse without usable coordinates', async ({ request }) => {
    const token = await getAdmin(request);
    for (const qs of ['reverse=1', 'reverse=1&lat=abc&lng=def', 'reverse=1&lat=23.3']) {
      const res = await request.get(`${BASE_URL}/api/geocode?${qs}`, {
        headers: headers(token),
        timeout: REQUEST_TIMEOUT,
      });
      expect(res.status(), `querystring: ${qs}`).toBe(400);
      expect((await res.json()).code).toBe('MISSING_FIELDS');
    }
  });

  test('a malformed bbox degrades to a worldwide search, it does not 400', async ({ request }) => {
    // bbox is always a relevance hint layered on the user's real query —
    // rejecting the whole request over a bad hint would break the typeahead.
    const token = await getAdmin(request);
    const res = await request.get(`${BASE_URL}/api/geocode?q=ranchi&bbox=nonsense`, {
      headers: headers(token),
      timeout: REQUEST_TIMEOUT,
    });
    expect([200, 502]).toContain(res.status());
  });
});

test.describe('GET /api/geocode — forward search', () => {
  test('returns a { results: [...] } envelope with usable coordinates', async ({ request }) => {
    const token = await getAdmin(request);
    const res = await request.get(
      `${BASE_URL}/api/geocode?q=${encodeURIComponent('Ranchi Jharkhand')}&limit=5`,
      { headers: headers(token), timeout: REQUEST_TIMEOUT },
    );
    if (isUpstreamOutage(res)) {
      test.skip(true, 'photon.komoot.io unavailable — upstream outage, not our regression');
      return;
    }
    expect(res.status()).toBe(200);

    const body = await res.json();
    expect(Array.isArray(body.results)).toBe(true);
    expect(body.results.length).toBeGreaterThan(0);

    const top = body.results[0];
    // Coordinates must be real numbers in range. GeoJSON is [lng, lat] and
    // the parser flips it — an inverted pair would still "work" while putting
    // every Indian clinic in the Indian Ocean, so assert the ranges.
    expect(typeof top.lat).toBe('number');
    expect(typeof top.lng).toBe('number');
    expect(top.lat).toBeGreaterThanOrEqual(-90);
    expect(top.lat).toBeLessThanOrEqual(90);
    expect(top.lng).toBeGreaterThanOrEqual(-180);
    expect(top.lng).toBeLessThanOrEqual(180);
    expect(typeof top.display_name).toBe('string');
    expect(top.display_name.length).toBeGreaterThan(0);
  });

  test('every address component is a string, never null', async ({ request }) => {
    // The frontend spreads these straight onto controlled form inputs; a null
    // would trigger React's uncontrolled-input warning and blank the field.
    const token = await getAdmin(request);
    const res = await request.get(
      `${BASE_URL}/api/geocode?q=${encodeURIComponent('Bangalore')}&limit=3`,
      { headers: headers(token), timeout: REQUEST_TIMEOUT },
    );
    if (isUpstreamOutage(res)) {
      test.skip(true, 'photon.komoot.io unavailable — upstream outage');
      return;
    }
    const body = await res.json();
    for (const row of body.results) {
      for (const key of ['display_name', 'name', 'street', 'city', 'district', 'county', 'state', 'country', 'postcode']) {
        expect(typeof row[key], `${key} on ${row.display_name}`).toBe('string');
      }
    }
  });

  test('honours limit and clamps it to 10', async ({ request }) => {
    const token = await getAdmin(request);
    const res = await request.get(
      `${BASE_URL}/api/geocode?q=${encodeURIComponent('Delhi')}&limit=99`,
      { headers: headers(token), timeout: REQUEST_TIMEOUT },
    );
    if (isUpstreamOutage(res)) {
      test.skip(true, 'photon.komoot.io unavailable — upstream outage');
      return;
    }
    const body = await res.json();
    expect(body.results.length).toBeLessThanOrEqual(10);
  });

  test('bbox constrains results to the requested region', async ({ request }) => {
    // The reason bbox exists at all: the upstream ranks on string similarity
    // with no country weighting, so an unboxed clinic-name search happily
    // returns a same-named business on another continent first.
    const token = await getAdmin(request);
    const res = await request.get(
      `${BASE_URL}/api/geocode?q=${encodeURIComponent('wellness clinic')}&limit=5&bbox=${INDIA_BBOX}`,
      { headers: headers(token), timeout: REQUEST_TIMEOUT },
    );
    if (isUpstreamOutage(res)) {
      test.skip(true, 'photon.komoot.io unavailable — upstream outage');
      return;
    }
    const body = await res.json();
    // An empty result set is a legitimate outcome for a hard filter; assert
    // only that whatever DID come back sits inside the box.
    for (const row of body.results) {
      expect(row.lng, row.display_name).toBeGreaterThanOrEqual(68.1);
      expect(row.lng, row.display_name).toBeLessThanOrEqual(97.4);
      expect(row.lat, row.display_name).toBeGreaterThanOrEqual(6.5);
      expect(row.lat, row.display_name).toBeLessThanOrEqual(35.7);
    }
  });
});

test.describe('GET /api/geocode — reverse', () => {
  test('resolves a coordinate pair to a display_name and echoes the input', async ({ request }) => {
    const token = await getAdmin(request);
    // Ranchi, Jharkhand — the reference clinic coordinates used throughout
    // backend/test/lib/attendanceGeofence.test.js.
    const res = await request.get(`${BASE_URL}/api/geocode?reverse=1&lat=23.3441&lng=85.3096`, {
      headers: headers(token),
      timeout: REQUEST_TIMEOUT,
    });
    if (isUpstreamOutage(res)) {
      test.skip(true, 'photon.komoot.io unavailable — upstream outage');
      return;
    }
    expect(res.status()).toBe(200);

    const body = await res.json();
    expect(body.lat).toBeCloseTo(23.3441, 4);
    expect(body.lng).toBeCloseTo(85.3096, 4);
    // display_name is null when the upstream finds nothing near the point
    // (mid-ocean, unmapped desert) — that is a valid answer, not an error.
    expect(body.display_name === null || typeof body.display_name === 'string').toBe(true);
  });
});

test.describe('GET /api/travel/pois/geocode — back-compat after the shared-lib refactor', () => {
  test('still answers with the original { results: [...] } envelope', async ({ request }) => {
    // This route now delegates to lib/geocodeProxy.js. The travel itinerary
    // editor's auto-pin flow depends on the response shape being unchanged.
    const token = await getAdmin(request);
    const res = await request.get(
      `${BASE_URL}/api/travel/pois/geocode?q=${encodeURIComponent('Goa')}`,
      { headers: headers(token), timeout: REQUEST_TIMEOUT },
    );
    if (isUpstreamOutage(res)) {
      test.skip(true, 'photon.komoot.io unavailable — upstream outage');
      return;
    }
    // 403 is acceptable here: the demo admin sits on a generic-vertical
    // tenant, and travel routes may be vertical-gated. Auth/shape is what
    // this test guards, not tenant eligibility.
    expect([200, 403]).toContain(res.status());
    if (res.status() === 200) {
      const body = await res.json();
      expect(Array.isArray(body.results)).toBe(true);
    }
  });
});
