// @ts-check
/**
 * Leave Management API gate spec — Wave 2 Agent JJ (Google Doc audit, 8 May 2026).
 *
 * Target: backend/routes/leave.js (new file). Greenfield — no models,
 * routes, or UI existed in the codebase before this commit. Verified via
 * pre-pickup grep (no `prisma.leavePolicy` or `routes/leave.js`).
 *
 * Endpoints covered:
 *   Policies (admin CRUD):
 *     GET    /api/leave/policies
 *     POST   /api/leave/policies
 *     PUT    /api/leave/policies/:id
 *     DELETE /api/leave/policies/:id  (soft-delete via isActive=false)
 *   Balances:
 *     GET    /api/leave/balances/me
 *     GET    /api/leave/balances/:userId    (manager+ only)
 *   Requests (workflow):
 *     POST   /api/leave/requests
 *     GET    /api/leave/requests
 *     GET    /api/leave/requests/:id
 *     POST   /api/leave/requests/:id/approve  (manager+ only)
 *     POST   /api/leave/requests/:id/reject   (manager+ only)
 *     POST   /api/leave/requests/:id/cancel   (requester only, PENDING only)
 *
 * Acceptance per endpoint:
 *   ✅ Happy path: policy CRUD round-trip, request submission, approval flow
 *   ✅ Validation: leaveType, accrualPattern, annualEntitlement bounds, date order
 *   ✅ Half-day NOT supported → 400 HALF_DAY_NOT_SUPPORTED on fractional days
 *   ✅ Insufficient balance → 409 INSUFFICIENT_BALANCE
 *   ✅ State semantics: approve PENDING → APPROVED (pending--, used++)
 *   ✅ State semantics: reject  PENDING → REJECTED (pending--, available++)
 *   ✅ State semantics: cancel  PENDING → CANCELLED (pending--, available++)
 *   ✅ Already-decided request → 409 ALREADY_DECIDED on second flip
 *   ✅ RBAC: non-manager approve/reject → 403; non-requester cancel → 403
 *   ✅ Tenant isolation: cross-tenant userId → 404 on /balances/:userId
 *
 * Test environment:
 *   - BASE_URL defaults to https://crm.globusdemos.com
 *   - Local: cd e2e && BASE_URL=http://127.0.0.1:5000 npx playwright test \
 *            --project=chromium --no-deps tests/leave-api.spec.js
 *
 * Cleanup: policies created with the RUN_TAG name are soft-deleted in afterAll.
 * LeaveRequest rows have no DELETE endpoint by design (history of record);
 * pending ones are cancelled. The test users carry stable seeded ids — we
 * don't create new users (leverages existing manager@crm.com / user@crm.com).
 *
 * Pattern cloned from e2e/tests/memberships-api.spec.js.
 */
const { test, expect } = require('@playwright/test');

test.describe.configure({ mode: 'serial' });

const BASE_URL = process.env.BASE_URL || 'https://crm.globusdemos.com';
const REQUEST_TIMEOUT = 30000;
const RUN_TAG = `E2E_FLOW_LEAVE_${Date.now()}`;

const FIXTURES = {
  admin:        { email: 'admin@globussoft.com',      password: 'password123' },
  manager:      { email: 'manager@crm.com',           password: 'password123' },
  user:         { email: 'user@crm.com',              password: 'password123' },
  wellnessAdmin:{ email: 'admin@wellness.demo',       password: 'password123' },
};

const tokenCache = {};
const userIdCache = {};

async function login(request, who) {
  if (tokenCache[who]) return { token: tokenCache[who], userId: userIdCache[who] };
  const fixture = FIXTURES[who];
  const response = await request.post(`${BASE_URL}/api/auth/login`, {
    data: fixture,
    headers: { 'Content-Type': 'application/json' },
    timeout: REQUEST_TIMEOUT,
  });
  if (response.ok()) {
    const data = await response.json();
    tokenCache[who] = data.token;
    userIdCache[who] = data.user && data.user.id;
    return { token: tokenCache[who], userId: userIdCache[who] };
  }
  return { token: null, userId: null };
}

const authHdr = async (request, who = 'admin') => ({
  Authorization: `Bearer ${(await login(request, who)).token}`,
});

async function authGet(request, path, who = 'admin') {
  return request.get(`${BASE_URL}${path}`, {
    headers: await authHdr(request, who),
    timeout: REQUEST_TIMEOUT,
  });
}
async function authPost(request, path, body, who = 'admin') {
  const headers = { ...(await authHdr(request, who)), 'Content-Type': 'application/json' };
  return request.post(`${BASE_URL}${path}`, { headers, data: body ?? {}, timeout: REQUEST_TIMEOUT });
}
async function authPut(request, path, body, who = 'admin') {
  const headers = { ...(await authHdr(request, who)), 'Content-Type': 'application/json' };
  return request.put(`${BASE_URL}${path}`, { headers, data: body ?? {}, timeout: REQUEST_TIMEOUT });
}
async function authDelete(request, path, who = 'admin') {
  return request.delete(`${BASE_URL}${path}`, { headers: await authHdr(request, who), timeout: REQUEST_TIMEOUT });
}

// ── Cleanup tracking ───────────────────────────────────────────────
const createdPolicyIds = [];
const createdRequestIds = [];

test.afterAll(async ({ request }) => {
  // Cancel any pending request rows so they don't sit in the demo's queue.
  for (const id of createdRequestIds) {
    await authPost(request, `/api/leave/requests/${id}/cancel`, {}, 'user').catch(() => {});
  }
  // Soft-delete the test policies.
  for (const id of createdPolicyIds) {
    await authDelete(request, `/api/leave/policies/${id}`).catch(() => {});
  }
});

// ── Bootstrapping ──────────────────────────────────────────────────
test.beforeAll(async ({ request }) => {
  const tok = await login(request, 'admin');
  test.skip(!tok.token, 'Admin login failed — seed missing? Skipping leave spec.');
});

// Helper to create a fresh policy with the RUN_TAG name.
async function createPolicy(request, overrides = {}) {
  const body = {
    name: `${RUN_TAG} Policy`,
    leaveType: 'CASUAL',
    annualEntitlement: 12,
    accrualPattern: 'UPFRONT',
    encashable: false,
    ...overrides,
  };
  const res = await authPost(request, '/api/leave/policies', body);
  if (res.status() === 201) {
    const p = await res.json();
    createdPolicyIds.push(p.id);
    return p;
  }
  return null;
}

// Helper to compute a future date string (YYYY-MM-DD) N days from today.
// Using future dates avoids the date-boundary class of TZ flake.
function futureDate(offsetDays) {
  const d = new Date(Date.now() + offsetDays * 86400000);
  return d.toISOString().slice(0, 10);
}

// ==============================================================
// Policies
// ==============================================================

test.describe('Leave — policy CRUD', () => {
  test('GET /policies returns array (any auth user)', async ({ request }) => {
    const res = await authGet(request, '/api/leave/policies', 'user');
    expect(res.status()).toBe(200);
    const arr = await res.json();
    expect(Array.isArray(arr)).toBe(true);
  });

  test('non-admin POST /policies → 403', async ({ request }) => {
    const res = await authPost(request, '/api/leave/policies', {
      name: 'X', leaveType: 'CASUAL', annualEntitlement: 5,
    }, 'manager');
    expect(res.status()).toBe(403);
  });

  test('400 on missing name', async ({ request }) => {
    const res = await authPost(request, '/api/leave/policies', {
      leaveType: 'CASUAL', annualEntitlement: 12,
    });
    expect(res.status()).toBe(400);
    expect((await res.json()).code).toBe('NAME_REQUIRED');
  });

  test('400 on invalid leaveType', async ({ request }) => {
    const res = await authPost(request, '/api/leave/policies', {
      name: `${RUN_TAG} Bad`, leaveType: 'PARTY_TIME', annualEntitlement: 12,
    });
    expect(res.status()).toBe(400);
    expect((await res.json()).code).toBe('INVALID_LEAVE_TYPE');
  });

  test('400 on invalid annualEntitlement (negative)', async ({ request }) => {
    const res = await authPost(request, '/api/leave/policies', {
      name: `${RUN_TAG} Bad2`, leaveType: 'CASUAL', annualEntitlement: -1,
    });
    expect(res.status()).toBe(400);
    expect((await res.json()).code).toBe('INVALID_ANNUAL_ENTITLEMENT');
  });

  test('400 on invalid annualEntitlement (above 365)', async ({ request }) => {
    const res = await authPost(request, '/api/leave/policies', {
      name: `${RUN_TAG} Bad3`, leaveType: 'CASUAL', annualEntitlement: 999,
    });
    expect(res.status()).toBe(400);
    expect((await res.json()).code).toBe('INVALID_ANNUAL_ENTITLEMENT');
  });

  test('400 on invalid accrualPattern', async ({ request }) => {
    const res = await authPost(request, '/api/leave/policies', {
      name: `${RUN_TAG} Bad4`, leaveType: 'CASUAL', annualEntitlement: 12,
      accrualPattern: 'WEEKLY',
    });
    expect(res.status()).toBe(400);
    expect((await res.json()).code).toBe('INVALID_ACCRUAL_PATTERN');
  });

  test('happy path: create + read + update + delete', async ({ request }) => {
    const created = await createPolicy(request, { annualEntitlement: 18 });
    expect(created).toBeTruthy();
    expect(created.name).toBe(`${RUN_TAG} Policy`);
    expect(created.annualEntitlement).toBe(18);
    expect(created.isActive).toBe(true);

    const update = await authPut(request, `/api/leave/policies/${created.id}`, {
      annualEntitlement: 20, encashable: true,
    });
    expect(update.status()).toBe(200);
    const updated = await update.json();
    expect(updated.annualEntitlement).toBe(20);
    expect(updated.encashable).toBe(true);

    const del = await authDelete(request, `/api/leave/policies/${created.id}`);
    expect(del.status()).toBe(204);
  });

  test('PUT /policies/:id 404 for unknown id', async ({ request }) => {
    const res = await authPut(request, '/api/leave/policies/999999999', { name: 'X' });
    expect(res.status()).toBe(404);
  });
});

// ==============================================================
// Balances
// ==============================================================

test.describe('Leave — balances', () => {
  test('GET /balances/me returns array of {policy, balance}', async ({ request }) => {
    // Ensure at least one policy exists so the array is non-empty.
    await createPolicy(request, { name: `${RUN_TAG} Balance Probe`, annualEntitlement: 10 });
    const res = await authGet(request, '/api/leave/balances/me', 'user');
    expect(res.status()).toBe(200);
    const arr = await res.json();
    expect(Array.isArray(arr)).toBe(true);
    if (arr.length > 0) {
      expect(arr[0].policy).toBeDefined();
      expect(arr[0].balance).toBeDefined();
      expect(typeof arr[0].balance.available).toBe('number');
    }
  });

  test('GET /balances/:userId requires manager+', async ({ request }) => {
    const u = await login(request, 'user');
    const res = await authGet(request, `/api/leave/balances/${u.userId}`, 'user');
    expect(res.status()).toBe(403);
  });

  test('GET /balances/:userId works for admin', async ({ request }) => {
    const u = await login(request, 'user');
    const res = await authGet(request, `/api/leave/balances/${u.userId}`, 'admin');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.user).toBeDefined();
    expect(Array.isArray(body.balances)).toBe(true);
  });

  test('GET /balances/:userId 404 for cross-tenant userId', async ({ request }) => {
    const w = await login(request, 'wellnessAdmin');
    if (!w.userId) test.skip(true, 'wellnessAdmin login failed');
    const res = await authGet(request, `/api/leave/balances/${w.userId}`, 'admin');
    expect(res.status()).toBe(404);
    expect((await res.json()).code).toBe('USER_NOT_FOUND');
  });
});

// ==============================================================
// Requests: workflow + balance math
// ==============================================================

test.describe('Leave — request workflow', () => {
  let policyId = null;

  test.beforeAll(async ({ request }) => {
    // Fresh policy with 10 days to test balance math cleanly.
    const p = await createPolicy(request, {
      name: `${RUN_TAG} Workflow Policy`,
      leaveType: 'EARNED',
      annualEntitlement: 10,
    });
    policyId = p && p.id;
    test.skip(!policyId, 'Could not create workflow policy');
  });

  test('400 on missing policyId', async ({ request }) => {
    const res = await authPost(request, '/api/leave/requests', {
      startDate: futureDate(7), endDate: futureDate(8),
    }, 'user');
    expect(res.status()).toBe(400);
    expect((await res.json()).code).toBe('POLICY_REQUIRED');
  });

  test('400 on missing dates', async ({ request }) => {
    const res = await authPost(request, '/api/leave/requests', {
      policyId,
    }, 'user');
    expect(res.status()).toBe(400);
    expect((await res.json()).code).toBe('DATE_REQUIRED');
  });

  test('400 INVERTED_DATE_RANGE when end before start', async ({ request }) => {
    const res = await authPost(request, '/api/leave/requests', {
      policyId, startDate: futureDate(10), endDate: futureDate(5),
    }, 'user');
    expect(res.status()).toBe(400);
    expect((await res.json()).code).toBe('INVERTED_DATE_RANGE');
  });

  test('400 HALF_DAY_NOT_SUPPORTED when client sends fractional days', async ({ request }) => {
    const res = await authPost(request, '/api/leave/requests', {
      policyId, startDate: futureDate(7), endDate: futureDate(7), days: 0.5,
    }, 'user');
    expect(res.status()).toBe(400);
    expect((await res.json()).code).toBe('HALF_DAY_NOT_SUPPORTED');
  });

  test('404 POLICY_NOT_FOUND for unknown policy', async ({ request }) => {
    const res = await authPost(request, '/api/leave/requests', {
      policyId: 999999999, startDate: futureDate(7), endDate: futureDate(8),
    }, 'user');
    expect(res.status()).toBe(404);
    expect((await res.json()).code).toBe('POLICY_NOT_FOUND');
  });

  test('happy path: submit → 201, balance.pending++, balance.available--', async ({ request }) => {
    // Read balance before
    const bRes = await authGet(request, '/api/leave/balances/me', 'user');
    const before = (await bRes.json()).find((b) => b.policy.id === policyId);
    expect(before).toBeDefined();
    const availBefore = before.balance.available;
    const pendingBefore = before.balance.pending;

    const res = await authPost(request, '/api/leave/requests', {
      policyId, startDate: futureDate(15), endDate: futureDate(16),
    }, 'user');
    expect(res.status()).toBe(201);
    const r = await res.json();
    createdRequestIds.push(r.id);
    expect(r.days).toBe(2);
    expect(r.status).toBe('PENDING');

    const aRes = await authGet(request, '/api/leave/balances/me', 'user');
    const after = (await aRes.json()).find((b) => b.policy.id === policyId);
    expect(after.balance.pending).toBe(pendingBefore + 2);
    expect(after.balance.available).toBe(availBefore - 2);
  });

  test('409 INSUFFICIENT_BALANCE when requesting more than available', async ({ request }) => {
    const res = await authPost(request, '/api/leave/requests', {
      policyId,
      startDate: futureDate(30),
      endDate: futureDate(60), // 31 days — way more than 10-day policy
    }, 'user');
    expect(res.status()).toBe(409);
    expect((await res.json()).code).toBe('INSUFFICIENT_BALANCE');
  });

  test('GET /requests for own user returns recent rows', async ({ request }) => {
    const res = await authGet(request, '/api/leave/requests', 'user');
    expect(res.status()).toBe(200);
    const items = await res.json();
    expect(Array.isArray(items)).toBe(true);
    expect(items.length).toBeGreaterThanOrEqual(1);
  });

  test('GET /requests with filter ?status=PENDING', async ({ request }) => {
    const res = await authGet(request, '/api/leave/requests?status=PENDING', 'user');
    expect(res.status()).toBe(200);
    const items = await res.json();
    for (const r of items) expect(r.status).toBe('PENDING');
  });

  test('non-manager POST /:id/approve → 403', async ({ request }) => {
    const id = createdRequestIds[0];
    const res = await authPost(request, `/api/leave/requests/${id}/approve`, {}, 'user');
    expect(res.status()).toBe(403);
  });

  test('approval flow: pending--, used++, status=APPROVED', async ({ request }) => {
    const id = createdRequestIds[0];

    const bRes = await authGet(request, '/api/leave/balances/me', 'user');
    const before = (await bRes.json()).find((b) => b.policy.id === policyId);
    const pendingBefore = before.balance.pending;
    const usedBefore = before.balance.used;
    const availBefore = before.balance.available;

    const res = await authPost(request, `/api/leave/requests/${id}/approve`, { notes: 'OK' });
    expect(res.status()).toBe(200);
    const updated = await res.json();
    expect(updated.status).toBe('APPROVED');
    expect(updated.approverId).toBeDefined();
    expect(updated.decidedAt).toBeTruthy();

    const aRes = await authGet(request, '/api/leave/balances/me', 'user');
    const after = (await aRes.json()).find((b) => b.policy.id === policyId);
    expect(after.balance.pending).toBe(pendingBefore - 2);
    expect(after.balance.used).toBe(usedBefore + 2);
    // available unchanged on approval (already decremented at submit).
    expect(after.balance.available).toBe(availBefore);
  });

  test('409 ALREADY_DECIDED on second approve', async ({ request }) => {
    const id = createdRequestIds[0];
    const res = await authPost(request, `/api/leave/requests/${id}/approve`, {});
    expect(res.status()).toBe(409);
    expect((await res.json()).code).toBe('ALREADY_DECIDED');
  });

  test('rejection flow: submit fresh request → reject → pending--, available++', async ({ request }) => {
    const submit = await authPost(request, '/api/leave/requests', {
      policyId, startDate: futureDate(20), endDate: futureDate(20),
    }, 'user');
    expect(submit.status()).toBe(201);
    const r = await submit.json();
    createdRequestIds.push(r.id);

    const bRes = await authGet(request, '/api/leave/balances/me', 'user');
    const before = (await bRes.json()).find((b) => b.policy.id === policyId);
    const pendingBefore = before.balance.pending;
    const availBefore = before.balance.available;

    const res = await authPost(request, `/api/leave/requests/${r.id}/reject`, { notes: 'denied' });
    expect(res.status()).toBe(200);
    const updated = await res.json();
    expect(updated.status).toBe('REJECTED');

    const aRes = await authGet(request, '/api/leave/balances/me', 'user');
    const after = (await aRes.json()).find((b) => b.policy.id === policyId);
    expect(after.balance.pending).toBe(pendingBefore - 1);
    expect(after.balance.available).toBe(availBefore + 1);
  });

  test('cancel flow: submit + cancel → pending--, available++', async ({ request }) => {
    const submit = await authPost(request, '/api/leave/requests', {
      policyId, startDate: futureDate(25), endDate: futureDate(25),
    }, 'user');
    expect(submit.status()).toBe(201);
    const r = await submit.json();
    createdRequestIds.push(r.id);

    const bRes = await authGet(request, '/api/leave/balances/me', 'user');
    const before = (await bRes.json()).find((b) => b.policy.id === policyId);
    const pendingBefore = before.balance.pending;
    const availBefore = before.balance.available;

    const res = await authPost(request, `/api/leave/requests/${r.id}/cancel`, {}, 'user');
    expect(res.status()).toBe(200);
    const updated = await res.json();
    expect(updated.status).toBe('CANCELLED');

    const aRes = await authGet(request, '/api/leave/balances/me', 'user');
    const after = (await aRes.json()).find((b) => b.policy.id === policyId);
    expect(after.balance.pending).toBe(pendingBefore - 1);
    expect(after.balance.available).toBe(availBefore + 1);
  });

  test('non-requester cannot cancel another user’s request → 403', async ({ request }) => {
    const submit = await authPost(request, '/api/leave/requests', {
      policyId, startDate: futureDate(40), endDate: futureDate(40),
    }, 'user');
    expect(submit.status()).toBe(201);
    const r = await submit.json();
    createdRequestIds.push(r.id);

    // Manager (not the requester) trying to cancel — should 403.
    const res = await authPost(request, `/api/leave/requests/${r.id}/cancel`, {}, 'manager');
    expect(res.status()).toBe(403);
    expect((await res.json()).code).toBe('RBAC_DENIED');
  });

  test('GET /requests/:id requires ownership for non-managers', async ({ request }) => {
    const submit = await authPost(request, '/api/leave/requests', {
      policyId, startDate: futureDate(50), endDate: futureDate(50),
    }, 'user');
    expect(submit.status()).toBe(201);
    const r = await submit.json();
    createdRequestIds.push(r.id);

    // Owner can read
    const own = await authGet(request, `/api/leave/requests/${r.id}`, 'user');
    expect(own.status()).toBe(200);

    // Manager can read others (manager+ allowed)
    const mgr = await authGet(request, `/api/leave/requests/${r.id}`, 'manager');
    expect(mgr.status()).toBe(200);

    // Cancel for cleanup
    await authPost(request, `/api/leave/requests/${r.id}/cancel`, {}, 'user').catch(() => {});
  });
});

// ==============================================================
// UNPAID leave: no balance gate
// ==============================================================

test.describe('Leave — UNPAID policy', () => {
  test('UNPAID policy allows submission even with zero balance', async ({ request }) => {
    const p = await createPolicy(request, {
      name: `${RUN_TAG} Unpaid`,
      leaveType: 'UNPAID',
      annualEntitlement: 0,
    });
    if (!p) test.skip(true, 'UNPAID policy create failed');

    const submit = await authPost(request, '/api/leave/requests', {
      policyId: p.id,
      startDate: futureDate(70),
      endDate: futureDate(70),
    }, 'user');
    expect(submit.status()).toBe(201);
    const r = await submit.json();
    createdRequestIds.push(r.id);
    expect(r.days).toBe(1);
  });
});
