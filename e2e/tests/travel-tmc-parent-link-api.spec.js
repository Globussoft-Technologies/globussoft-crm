// @ts-check
/**
 * Gate coverage for the admin-owned TMC parent registration link.
 *
 * The route returns the same deterministic link consumed by the Roles page
 * and by the public landing-page decorator. A freshly seeded CI trip has no
 * assigned teacher, so the admin test accepts the expected TEACHER_REQUIRED
 * response while also exercising the success path when a demo trip is already
 * assigned.
 */

const { test, expect } = require("@playwright/test");

test.describe.configure({ mode: "serial" });

const BASE_URL = process.env.BASE_URL || "https://crm.globusdemos.com";
const REQUEST_TIMEOUT = 60000;

let adminToken = null;
let managerToken = null;
let tripId = null;

async function loginAs(request, email, password) {
  const response = await request.post(`${BASE_URL}/api/auth/login`, {
    data: { email, password },
    headers: { "Content-Type": "application/json" },
    timeout: REQUEST_TIMEOUT,
  });
  if (!response.ok()) return null;
  return (await response.json()).token || null;
}

async function getAdmin(request) {
  if (!adminToken) adminToken = await loginAs(request, "yasin@travelstall.in", "password123");
  return adminToken;
}

async function getManager(request) {
  if (!managerToken) managerToken = await loginAs(request, "tmc-ops@travelstall.demo", "password123");
  return managerToken;
}

function authHeaders(token) {
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}

test.beforeAll(async ({ request }) => {
  const token = await getAdmin(request);
  if (!token) return;
  const response = await request.get(`${BASE_URL}/api/travel/trips?limit=1`, {
    headers: authHeaders(token),
    timeout: REQUEST_TIMEOUT,
  });
  if (!response.ok()) return;
  tripId = (await response.json()).trips?.[0]?.id || null;
});

test("ADMIN can generate the canonical parent link for an assigned TMC trip", async ({ request }) => {
  const token = await getAdmin(request);
  if (!token || !tripId) test.skip(true, "travel admin or TMC trip is not seeded");

  const response = await request.post(`${BASE_URL}/api/portal/tmc/staff/trips/${tripId}/parent-link`, {
    headers: authHeaders(token),
    data: {},
    timeout: REQUEST_TIMEOUT,
  });
  const body = await response.json();

  expect([200, 409]).toContain(response.status());
  if (response.status() === 409) {
    expect(body.code).toBe("TEACHER_REQUIRED");
    return;
  }

  expect(body).toMatchObject({ linkType: "trip-specific", trip: { id: tripId } });
  const link = new URL(body.link);
  expect(link.pathname).toBe("/tmc/register/parent");
  expect(link.searchParams.get("token")).toBeTruthy();
});

test("MANAGER cannot generate a TMC parent link", async ({ request }) => {
  const token = await getManager(request);
  if (!token || !tripId) test.skip(true, "TMC manager or trip is not seeded");

  const response = await request.post(`${BASE_URL}/api/portal/tmc/staff/trips/${tripId}/parent-link`, {
    headers: authHeaders(token),
    data: {},
    timeout: REQUEST_TIMEOUT,
  });
  expect(response.status()).toBe(403);
  expect((await response.json()).code).toBe("RBAC_DENIED");
});

test("the parent-link route validates the trip id", async ({ request }) => {
  const token = await getAdmin(request);
  if (!token) test.skip(true, "travel admin is not seeded");

  const response = await request.post(`${BASE_URL}/api/portal/tmc/staff/trips/not-a-trip/parent-link`, {
    headers: authHeaders(token),
    data: {},
    timeout: REQUEST_TIMEOUT,
  });
  expect(response.status()).toBe(400);
  expect((await response.json()).code).toBe("INVALID_TRIP_ID");
});
