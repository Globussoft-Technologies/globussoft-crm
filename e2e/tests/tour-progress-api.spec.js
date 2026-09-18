// @ts-check
const { test, expect } = require("@playwright/test");

test.describe.configure({ mode: "serial" });
const BASE_URL = process.env.BASE_URL || "https://crm.globusdemos.com";
const TOUR_KEY = `e2e-tour-${Date.now()}:1`;
let adminToken;
let userToken;
let originalAdminState;

async function login(request, email) {
  const response = await request.post(`${BASE_URL}/api/auth/login`, {
    data: { email, password: "password123" },
    timeout: 60000,
  });
  expect(response.ok()).toBeTruthy();
  return (await response.json()).token;
}

const headers = (token) => ({ Authorization: `Bearer ${token}`, "Content-Type": "application/json" });
const getState = (request, token) => request.get(`${BASE_URL}/api/tours/state`, { headers: headers(token), timeout: 60000 });
const putState = (request, token, data) => request.put(`${BASE_URL}/api/tours/state`, { headers: headers(token), data, timeout: 60000 });

test.beforeAll(async ({ request }) => {
  adminToken = await login(request, "admin@globussoft.com");
  userToken = await login(request, "user@crm.com");
  originalAdminState = await (await getState(request, adminToken)).json();
});

test.afterAll(async ({ request }) => {
  if (!adminToken || !originalAdminState) return;
  try {
    const current = await (await getState(request, adminToken)).json();
    const restoredAt = new Date(Date.now() + 1000).toISOString();
    await putState(request, adminToken, {
      preferences: { ...originalAdminState.preferences, updatedAt: restoredAt },
      progress: Object.fromEntries(Object.entries(originalAdminState.progress).map(([key, value]) => [
        key,
        { ...value, updatedAt: restoredAt },
      ])),
      progressResetAt: current.progressResetAt,
    });
  } catch {
    // Demo-hygiene does not remove preference rows; best-effort restoration is
    // intentionally non-fatal when the target environment is restarting.
  }
});

test("tour state requires authentication", async ({ request }) => {
  expect((await request.get(`${BASE_URL}/api/tours/state`)).status()).toBe(401);
});

test("organization preference is readable by users but writable only by administrators", async ({ request }) => {
  const currentResponse = await request.get(`${BASE_URL}/api/tours/organization-preferences`, { headers: headers(userToken) });
  expect(currentResponse.ok()).toBeTruthy();
  const current = await currentResponse.json();
  expect(typeof current.organizationEnabled).toBe("boolean");

  const denied = await request.put(`${BASE_URL}/api/tours/organization-preferences`, {
    headers: headers(userToken),
    data: { organizationEnabled: current.organizationEnabled },
  });
  expect(denied.status()).toBe(403);
  expect((await denied.json()).code).toBe("RBAC_DENIED");

  const allowed = await request.put(`${BASE_URL}/api/tours/organization-preferences`, {
    headers: headers(adminToken),
    data: { organizationEnabled: current.organizationEnabled },
  });
  expect(allowed.ok()).toBeTruthy();
});

test("preferences and progress persist for the authenticated user", async ({ request }) => {
  const updatedAt = new Date().toISOString();
  const response = await putState(request, adminToken, {
    preferences: { enabled: true, autoStart: false, updatedAt },
    progress: { ...originalAdminState.progress, [TOUR_KEY]: { status: "IN_PROGRESS", currentStep: 2, updatedAt } },
    progressResetAt: originalAdminState.progressResetAt,
  });
  expect(response.ok()).toBeTruthy();
  const persisted = await (await getState(request, adminToken)).json();
  expect(persisted.preferences.autoStart).toBe(false);
  expect(persisted.progress[TOUR_KEY]).toMatchObject({ status: "IN_PROGRESS", currentStep: 2 });
});

test("progress is isolated between users in the same tenant", async ({ request }) => {
  const otherUser = await (await getState(request, userToken)).json();
  expect(otherUser.progress[TOUR_KEY]).toBeUndefined();
});

test("single-tour updates validate their contract", async ({ request }) => {
  const valid = await request.put(`${BASE_URL}/api/tours/progress/${TOUR_KEY}`, {
    headers: headers(adminToken),
    data: { status: "COMPLETED", currentStep: 4 },
  });
  expect(valid.ok()).toBeTruthy();
  expect((await valid.json()).progress[TOUR_KEY].status).toBe("COMPLETED");

  const invalid = await request.put(`${BASE_URL}/api/tours/progress/${TOUR_KEY}`, {
    headers: headers(adminToken),
    data: { status: "made-up", currentStep: -1 },
  });
  expect(invalid.status()).toBe(400);
  expect((await invalid.json()).code).toBe("INVALID_TOUR_PROGRESS");
});

test("reset clears progress and returns a cross-device reset marker", async ({ request }) => {
  const response = await request.delete(`${BASE_URL}/api/tours/progress`, { headers: headers(adminToken) });
  expect(response.ok()).toBeTruthy();
  const body = await response.json();
  expect(body.progress).toEqual({});
  expect(Number.isNaN(Date.parse(body.progressResetAt))).toBe(false);
});
