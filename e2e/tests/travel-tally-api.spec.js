// @ts-check
/** Read-only API regression coverage for the Travel Tally workspace. */

const { test, expect } = require("@playwright/test");

test.describe.configure({ mode: "serial" });

const BASE_URL = process.env.BASE_URL || "https://crm.globusdemos.com";
const REQUEST_TIMEOUT = 60000;
let travelAdminToken = null;
let genericAdminToken = null;

async function loginAs(request, email) {
  const response = await request.post(`${BASE_URL}/api/auth/login`, {
    data: { email, password: "password123" },
    headers: { "Content-Type": "application/json" },
    timeout: REQUEST_TIMEOUT,
  });
  return response.ok() ? (await response.json()).token : null;
}

async function travelAdmin(request) {
  travelAdminToken ||= await loginAs(request, "yasin@travelstall.in");
  return travelAdminToken;
}

async function genericAdmin(request) {
  genericAdminToken ||= await loginAs(request, "admin@globussoft.com");
  return genericAdminToken;
}

const headers = (token) => ({ Authorization: `Bearer ${token}`, "Content-Type": "application/json" });

test("Tally masters requires authentication", async ({ request }) => {
  const response = await request.get(`${BASE_URL}/api/travel/tally/masters`, { timeout: REQUEST_TIMEOUT });
  expect([401, 403]).toContain(response.status());
});

test("Tally masters rejects a generic tenant", async ({ request }) => {
  const token = await genericAdmin(request);
  if (!token) test.skip(true, "generic admin login unavailable");
  const response = await request.get(`${BASE_URL}/api/travel/tally/masters`, {
    headers: headers(token),
    timeout: REQUEST_TIMEOUT,
  });
  expect(response.status()).toBe(403);
  expect((await response.json()).code).toBe("WRONG_VERTICAL");
});

test("Tally connector status is authenticated, travel-only, and never exposes its token hash", async ({ request }) => {
  const unauthenticated = await request.get(`${BASE_URL}/api/travel/tally/connector/status`, { timeout: REQUEST_TIMEOUT });
  expect([401, 403]).toContain(unauthenticated.status());

  const genericToken = await genericAdmin(request);
  if (!genericToken) test.skip(true, "generic admin login unavailable");
  const wrongVertical = await request.get(`${BASE_URL}/api/travel/tally/connector/status`, {
    headers: headers(genericToken),
    timeout: REQUEST_TIMEOUT,
  });
  expect(wrongVertical.status()).toBe(403);
  expect((await wrongVertical.json()).code).toBe("WRONG_VERTICAL");

  const token = await travelAdmin(request);
  if (!token) test.skip(true, "travel admin login unavailable");
  const response = await request.get(`${BASE_URL}/api/travel/tally/connector/status`, {
    headers: headers(token),
    timeout: REQUEST_TIMEOUT,
  });
  expect(response.status()).toBe(200);
  const body = await response.json();
  expect(typeof body.online).toBe("boolean");
  expect(typeof body.configured).toBe("boolean");
  expect(body.connectorUrl).toMatch(/^wss?:\/\//);
  expect(JSON.stringify(body)).not.toContain("tokenHash");
  expect(body).not.toHaveProperty("token");
});

test("direct Tally push rejects malformed XML before contacting a connector", async ({ request }) => {
  const token = await travelAdmin(request);
  if (!token) test.skip(true, "travel admin login unavailable");
  const response = await request.post(`${BASE_URL}/api/travel/tally/connector/push`, {
    headers: headers(token),
    data: { vouchersXml: "<not-tally />" },
    timeout: REQUEST_TIMEOUT,
  });
  expect(response.status()).toBe(400);
  expect((await response.json()).code).toBe("INVALID_TALLY_XML");
});

test("direct Tally push rejects destructive XML before contacting a connector", async ({ request }) => {
  const token = await travelAdmin(request);
  if (!token) test.skip(true, "travel admin login unavailable");
  const destructiveXml = '<?xml version="1.0"?><ENVELOPE><HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER><BODY><IMPORTDATA><REQUESTDESC><REPORTNAME>Vouchers</REPORTNAME></REQUESTDESC><REQUESTDATA><TALLYMESSAGE><VOUCHER ACTION="Delete"><VOUCHERNUMBER>TEST-1</VOUCHERNUMBER></VOUCHER></TALLYMESSAGE></REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>';
  const response = await request.post(`${BASE_URL}/api/travel/tally/connector/push`, {
    headers: headers(token),
    data: { vouchersXml: destructiveXml },
    timeout: REQUEST_TIMEOUT,
  });
  expect(response.status()).toBe(400);
  expect((await response.json()).code).toBe("UNSAFE_TALLY_XML");
});

test("Tally read endpoints return their pagination-safe envelopes", async ({ request }) => {
  const token = await travelAdmin(request);
  if (!token) test.skip(true, "travel admin login unavailable");
  for (const [path, key] of [
    ["/api/travel/tally/masters", "ledgers"],
    ["/api/travel/tally/sync-queue", "queue"],
    ["/api/travel/tally/sync-history", "history"],
    ["/api/travel/tally/sync-errors", "errors"],
  ]) {
    const response = await request.get(`${BASE_URL}${path}`, {
      headers: headers(token),
      timeout: REQUEST_TIMEOUT,
    });
    expect(response.status(), `${path}: ${await response.text()}`).toBe(200);
    expect(Array.isArray((await response.json())[key])).toBe(true);
  }
});

test("payment accounts reject malformed and unknown ledger ids without writing", async ({ request }) => {
  const token = await travelAdmin(request);
  if (!token) test.skip(true, "travel admin login unavailable");
  const malformed = await request.post(`${BASE_URL}/api/travel/tally/payment-accounts`, {
    headers: headers(token),
    data: { mode: "bank", accountName: "E2E validation only", ledgerId: "bad" },
    timeout: REQUEST_TIMEOUT,
  });
  expect(malformed.status()).toBe(400);
  expect((await malformed.json()).code).toBe("INVALID_LEDGER_ID");

  const missing = await request.post(`${BASE_URL}/api/travel/tally/payment-accounts`, {
    headers: headers(token),
    data: { mode: "bank", accountName: "E2E validation only", ledgerId: 2147483647 },
    timeout: REQUEST_TIMEOUT,
  });
  expect(missing.status()).toBe(404);
  expect((await missing.json()).code).toBe("LEDGER_NOT_FOUND");
});
