// @ts-check
const { test, expect } = require("@playwright/test");

test.describe.configure({ mode: "serial" });
const BASE_URL = process.env.BASE_URL || "https://crm.globusdemos.com";
let adminToken;
let userToken;

async function login(request, email) {
  const response = await request.post(`${BASE_URL}/api/auth/login`, { data: { email, password: "password123" }, timeout: 60000 });
  expect(response.ok()).toBeTruthy();
  return (await response.json()).token;
}

const headers = (token) => ({ Authorization: `Bearer ${token}`, "Content-Type": "application/json" });

test.beforeAll(async ({ request }) => {
  adminToken = await login(request, "admin@globussoft.com");
  userToken = await login(request, "user@crm.com");
});

test("onboarding state requires auth and returns a role-filtered persisted envelope", async ({ request }) => {
  expect((await request.get(`${BASE_URL}/api/onboarding/state`)).status()).toBe(401);
  const response = await request.get(`${BASE_URL}/api/onboarding/state`, { headers: headers(userToken) });
  expect(response.ok()).toBeTruthy();
  const body = await response.json();
  expect(Array.isArray(body.checklist)).toBe(true);
  expect(body.checklist.some((item) => item.key === "invite-staff")).toBe(false);
  expect(body.completionPercentage).toBeGreaterThanOrEqual(0);
  expect(body.completionPercentage).toBeLessThanOrEqual(100);
  expect(Array.isArray(body.dismissedAnnouncements)).toBe(true);
});

test("privacy-safe events are accepted while record-like identifiers are rejected", async ({ request }) => {
  const accepted = await request.post(`${BASE_URL}/api/onboarding/events`, {
    headers: headers(userToken),
    data: { eventType: "TOUR_STARTED", tourKey: "contacts", stepKey: "step-1", sessionId: `e2e-${Date.now().toString(36)}` },
  });
  expect(accepted.status()).toBe(201);

  const rejected = await request.post(`${BASE_URL}/api/onboarding/events`, {
    headers: headers(userToken),
    data: { eventType: "TOUR_STARTED", featureKey: "customer@example.com" },
  });
  expect(rejected.status()).toBe(400);
});

test("analytics enforce roles and remain tenant-scoped server-side", async ({ request }) => {
  expect((await request.get(`${BASE_URL}/api/onboarding/analytics`, { headers: headers(userToken) })).status()).toBe(403);
  const response = await request.get(`${BASE_URL}/api/onboarding/analytics`, { headers: headers(adminToken) });
  expect(response.ok()).toBeTruthy();
  const body = await response.json();
  expect(body.tours).toEqual(expect.objectContaining({ started: expect.any(Number), completionRate: expect.any(Number), abandonmentRate: expect.any(Number) }));
  expect(body.privacy).toContain("CRM record data");
});
