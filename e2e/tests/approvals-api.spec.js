// @ts-check
/**
 * Approvals API — e2e contract pin for backend/routes/approvals.js.
 *
 * File purpose
 * ─────────────
 * routes/approvals.js was 14.85% lines per c8 measurement. The sibling vitest
 * suite at backend/test/routes/approvals.test.js pins the unit-level shape with
 * mocked prisma, but no *-api.spec.js wired into the api_tests deploy gate
 * exercises the route through Express + real Prisma against the seeded MySQL
 * stack. Bare e2e/tests/approvals.spec.js + approvals-flow.spec.js exist but
 * are NOT in the gate. This file is the canonical gate-coverage partner —
 * once the parent cron wires it into deploy.yml + coverage.yml, the route's
 * exposure to silent regressions drops sharply.
 *
 * The route owns the cross-tenant approval-request state machine for Deals,
 * Quotes, Discounts, etc. Three load-bearing contracts:
 *   (1) Approve/Reject is ADMIN/MANAGER only — USER role is 403 at the gate.
 *   (2) State machine is mixed-contract: same-state re-mutation is
 *       idempotent-200 (no double audit) while cross-state (approve a
 *       REJECTED, reject an APPROVED) is 422 INVALID_APPROVAL_TRANSITION.
 *       This is deliberately NOT 409 — an earlier iteration tried to
 *       align with billing.js / deals.js (400 across the board) but that
 *       broke approvals-flow.spec.js so the route reverted.
 *   (3) Reject REQUIRES a non-empty comment (400 otherwise); approve accepts
 *       an optional comment. Cross-tenant lookups MUST 404, never reveal.
 *
 * Endpoints under test
 * ────────────────────
 *   GET    /api/approvals                  — tenant-scoped list (status/entity filters)
 *   GET    /api/approvals/pending-count    — badge count (role-aware)
 *   GET    /api/approvals/my-requests      — requests created by me
 *   GET    /api/approvals/to-approve       — ADMIN/MANAGER queue
 *   POST   /api/approvals                  — create (entity + entityId required)
 *   POST   /api/approvals/:id/approve      — ADMIN/MANAGER only; state-machine
 *   POST   /api/approvals/:id/reject       — ADMIN/MANAGER only; comment required
 *   DELETE /api/approvals/:id              — ADMIN only; hard delete + audit
 *
 * Contracts asserted (numbered)
 * ─────────────────────────────
 *   C1.  POST / happy → 201 with {entity, entityId, status:'PENDING',
 *        requestedBy, tenantId, requester hydrated}.
 *   C2.  POST / → 400 when entity missing or non-string.
 *   C3.  POST / → 400 when entityId not parseable to integer.
 *   C4.  GET / → 200 array; status='PENDING' filter narrows the rows.
 *   C5.  GET /pending-count → 200 {count:Number}; reflects new PENDING rows.
 *   C6.  GET /my-requests → 200; rows are requestedBy=me only.
 *   C7.  GET /to-approve → 200 list of PENDING; ADMIN/MANAGER gate
 *        — USER role gets 403 at the verifyRole layer.
 *   C8.  POST /:id/approve happy → 200; status='APPROVED', approvedBy set,
 *        approver hydrated. Audit row written (best-effort).
 *   C9.  POST /:id/approve as USER role → 403 (verifyRole gate).
 *   C10. POST /:id/approve on already-APPROVED → 200 idempotent
 *        (envelope carries {idempotent:true}, no state change, no double audit).
 *   C11. POST /:id/approve on REJECTED → 422 INVALID_APPROVAL_TRANSITION
 *        with {currentStatus:'REJECTED'} echoed.
 *   C12. POST /:id/reject happy → 200; status='REJECTED', comment persisted.
 *   C13. POST /:id/reject without comment → 400 ("comment is required").
 *   C14. POST /:id/reject on REJECTED → 200 idempotent ({idempotent:true}).
 *   C15. POST /:id/reject on APPROVED → 422 INVALID_APPROVAL_TRANSITION.
 *   C16. DELETE /:id → 200 {success:true,id} after audit row written.
 *   C17. DELETE /:id with bogus id → 404 ("not found").
 *   C18. Auth gate — every protected endpoint returns 401 (or 403) without token.
 *   C19. Cross-tenant access — GET/:id replacement: an approval id from the
 *        generic tenant must 404 on the approve route for a wellness admin.
 *
 * Tenant: generic (admin@globussoft.com). USER 403 case uses user@crm.com.
 * Cross-tenant case uses wellness admin (admin@wellness.demo).
 * Test data is tagged with RUN_TAG prefix; afterAll deletes created rows.
 *
 * Concurrency: each test creates its own approval row, so the spec is
 * parallel-safe. No describe-level serial pin needed.
 */
const { test, expect } = require('@playwright/test');

const BASE_URL = process.env.BASE_URL || 'https://crm.globusdemos.com';
const REQUEST_TIMEOUT = 60000;
const RUN_TAG = `E2E_APPROVALS_${Date.now()}_${process.pid}`;

let adminToken = null;
let adminUserId = null;
let userToken = null;
let userUserId = null;
let wellnessAdminToken = null;

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
    adminUserId = r.userId;
  }
  return { token: adminToken, userId: adminUserId };
}

async function getUser(request) {
  if (!userToken) {
    const r = await loginAs(request, 'user@crm.com', 'password123');
    userToken = r.token;
    userUserId = r.userId;
  }
  return { token: userToken, userId: userUserId };
}

async function getWellnessAdmin(request) {
  if (!wellnessAdminToken) {
    const r = await loginAs(request, 'admin@wellness.demo', 'password123');
    wellnessAdminToken = r.token;
  }
  return { token: wellnessAdminToken };
}

const authHeaders = (token) => ({
  Authorization: `Bearer ${token}`,
  'Content-Type': 'application/json',
});

async function get(request, token, path) {
  return request.get(`${BASE_URL}${path}`, { headers: authHeaders(token), timeout: REQUEST_TIMEOUT });
}
async function post(request, token, path, body) {
  return request.post(`${BASE_URL}${path}`, {
    headers: authHeaders(token),
    data: body ?? {},
    timeout: REQUEST_TIMEOUT,
  });
}
async function del(request, token, path) {
  return request.delete(`${BASE_URL}${path}`, { headers: authHeaders(token), timeout: REQUEST_TIMEOUT });
}

async function aget(request, path) { const { token } = await getAdmin(request); return get(request, token, path); }
async function apost(request, path, body) { const { token } = await getAdmin(request); return post(request, token, path, body); }
async function adel(request, path) { const { token } = await getAdmin(request); return del(request, token, path); }

// ── Cleanup tracking ───────────────────────────────────────────────────
const createdApprovalIds = [];

test.afterAll(async ({ request }) => {
  test.setTimeout(120_000);
  const { token } = await getAdmin(request);
  if (!token) return;
  for (const id of createdApprovalIds) {
    await del(request, token, `/api/approvals/${id}`).catch(() => {});
  }
});

// Helper: create a tagged approval and track for cleanup.
async function createApproval(request, overrides = {}) {
  const body = {
    entity: overrides.entity || 'Deal',
    entityId: overrides.entityId ?? 1,
    reason: `${RUN_TAG} ${overrides.suffix || 'discount waiver for Priya Sharma'}`,
  };
  const res = await apost(request, '/api/approvals', body);
  expect(res.status(), `approval create: ${await res.text()}`).toBe(201);
  const j = await res.json();
  createdApprovalIds.push(j.id);
  return j;
}

// ─── POST /api/approvals ──────────────────────────────────────────────────

test.describe('Approvals API — POST /', () => {
  test('C1: 201 happy returns hydrated envelope with PENDING status', async ({ request }) => {
    const { userId } = await getAdmin(request);
    const created = await createApproval(request, { suffix: 'c1-create' });
    expect(created.entity).toBe('Deal');
    expect(created.entityId).toBe(1);
    expect(created.reason).toContain(RUN_TAG);
    expect(created.status).toBe('PENDING');
    expect(created.requestedBy).toBe(userId);
    expect(created.tenantId).toBeTruthy();
    expect(typeof created.id).toBe('number');
    // hydrateUsers grafted requester on (id/name/email/role)
    expect(created.requester).toBeTruthy();
    expect(created.requester.id).toBe(userId);
    expect(typeof created.requester.email).toBe('string');
    // approver is null until approve/reject fires
    expect(created.approver).toBeNull();
  });

  test('C2: 400 when entity is missing', async ({ request }) => {
    const res = await apost(request, '/api/approvals', { entityId: 1 });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/entity/i);
  });

  test('C2: 400 when entity is empty string', async ({ request }) => {
    const res = await apost(request, '/api/approvals', { entity: '   ', entityId: 1 });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/entity/i);
  });

  test('C3: 400 when entityId is not parseable to integer', async ({ request }) => {
    const res = await apost(request, '/api/approvals', { entity: 'Deal', entityId: 'not-a-number' });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/entityId|integer/i);
  });
});

// ─── GET /api/approvals + filters ─────────────────────────────────────────

test.describe('Approvals API — list + filter routes', () => {
  test('C4: GET / returns array and respects status=PENDING filter', async ({ request }) => {
    const created = await createApproval(request, { suffix: 'c4-list-filter' });
    const res = await aget(request, '/api/approvals?status=PENDING');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    // Our newly-created PENDING row is in the filtered list
    const ours = body.find((r) => r.id === created.id);
    expect(ours).toBeTruthy();
    expect(ours.status).toBe('PENDING');
    // Every returned row has status PENDING (filter respected)
    for (const row of body) {
      expect(row.status).toBe('PENDING');
    }
  });

  test('C4: GET /?entity=Deal narrows by entity', async ({ request }) => {
    await createApproval(request, { entity: 'Deal', suffix: 'c4-entity-deal' });
    const res = await aget(request, '/api/approvals?entity=Deal');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    for (const row of body) {
      expect(row.entity).toBe('Deal');
    }
  });

  test('C5: GET /pending-count returns {count:Number} and reflects new PENDING rows', async ({ request }) => {
    const before = await aget(request, '/api/approvals/pending-count');
    expect(before.status()).toBe(200);
    const beforeBody = await before.json();
    expect(typeof beforeBody.count).toBe('number');

    await createApproval(request, { suffix: 'c5-pendingcount-bump' });
    const after = await aget(request, '/api/approvals/pending-count');
    expect(after.status()).toBe(200);
    const afterBody = await after.json();
    expect(afterBody.count).toBeGreaterThanOrEqual(beforeBody.count + 1);
  });

  test('C6: GET /my-requests returns only requestedBy=me rows', async ({ request }) => {
    const { userId } = await getAdmin(request);
    const created = await createApproval(request, { suffix: 'c6-myrequests' });
    const res = await aget(request, '/api/approvals/my-requests');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    // our row is present
    expect(body.find((r) => r.id === created.id)).toBeTruthy();
    // every row was requested by us
    for (const row of body) {
      expect(row.requestedBy).toBe(userId);
    }
  });

  test('C7: GET /to-approve returns PENDING list for ADMIN', async ({ request }) => {
    await createApproval(request, { suffix: 'c7-to-approve' });
    const res = await aget(request, '/api/approvals/to-approve');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    // every row in the queue is PENDING
    for (const row of body) {
      expect(row.status).toBe('PENDING');
    }
  });

  test('C7: GET /to-approve as USER role → 403 (verifyRole gate)', async ({ request }) => {
    const { token } = await getUser(request);
    if (!token) test.skip(true, 'USER role login unavailable on this stack');
    const res = await get(request, token, '/api/approvals/to-approve');
    expect(res.status()).toBe(403);
  });
});

// ─── POST /:id/approve ────────────────────────────────────────────────────

test.describe('Approvals API — POST /:id/approve', () => {
  test('C8: 200 happy — transitions PENDING → APPROVED, hydrates approver', async ({ request }) => {
    const { userId } = await getAdmin(request);
    const created = await createApproval(request, { suffix: 'c8-approve-happy' });
    const res = await apost(request, `/api/approvals/${created.id}/approve`, {
      comment: `${RUN_TAG} looks good`,
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.id).toBe(created.id);
    expect(body.status).toBe('APPROVED');
    expect(body.approvedBy).toBe(userId);
    expect(body.approvedAt).toBeTruthy();
    expect(body.comment).toContain(RUN_TAG);
    expect(body.approver).toBeTruthy();
    expect(body.approver.id).toBe(userId);
  });

  test('C9: 403 when USER role attempts to approve (verifyRole gate)', async ({ request }) => {
    const created = await createApproval(request, { suffix: 'c9-user-approve' });
    const { token } = await getUser(request);
    if (!token) test.skip(true, 'USER role login unavailable on this stack');
    const res = await post(request, token, `/api/approvals/${created.id}/approve`, {});
    expect(res.status()).toBe(403);
  });

  test('C10: re-approving an APPROVED row is idempotent-200 ({idempotent:true})', async ({ request }) => {
    const created = await createApproval(request, { suffix: 'c10-double-approve' });
    const first = await apost(request, `/api/approvals/${created.id}/approve`, {});
    expect(first.status()).toBe(200);
    const second = await apost(request, `/api/approvals/${created.id}/approve`, {});
    // Documented contract: same-state re-mutation is idempotent 200 with
    // {idempotent:true} (NOT 409, NOT 422). Don't drift this without
    // updating approvals-flow.spec.js too.
    expect(second.status()).toBe(200);
    const body = await second.json();
    expect(body.idempotent).toBe(true);
    expect(body.status).toBe('APPROVED');
  });

  test('C11: approving a REJECTED row → 422 INVALID_APPROVAL_TRANSITION', async ({ request }) => {
    const created = await createApproval(request, { suffix: 'c11-cross-state-approve' });
    // First reject it
    const rej = await apost(request, `/api/approvals/${created.id}/reject`, {
      comment: `${RUN_TAG} rejecting before cross-state probe`,
    });
    expect(rej.status()).toBe(200);
    // Then try to approve — must be 422
    const res = await apost(request, `/api/approvals/${created.id}/approve`, {});
    expect(res.status()).toBe(422);
    const body = await res.json();
    expect(body.code).toBe('INVALID_APPROVAL_TRANSITION');
    expect(body.currentStatus).toBe('REJECTED');
  });

  test('C8: 404 when id does not exist in tenant scope', async ({ request }) => {
    const res = await apost(request, '/api/approvals/99999999/approve', {});
    expect(res.status()).toBe(404);
    const body = await res.json();
    expect(body.error).toMatch(/not found/i);
  });
});

// ─── POST /:id/reject ─────────────────────────────────────────────────────

test.describe('Approvals API — POST /:id/reject', () => {
  test('C12: 200 happy — transitions PENDING → REJECTED, comment persisted', async ({ request }) => {
    const { userId } = await getAdmin(request);
    const created = await createApproval(request, { suffix: 'c12-reject-happy' });
    const comment = `${RUN_TAG} insufficient justification`;
    const res = await apost(request, `/api/approvals/${created.id}/reject`, { comment });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('REJECTED');
    expect(body.approvedBy).toBe(userId);
    expect(body.approvedAt).toBeTruthy();
    expect(body.comment).toBe(comment);
  });

  test('C13: 400 when reject body has no comment', async ({ request }) => {
    const created = await createApproval(request, { suffix: 'c13-reject-nocomment' });
    const res = await apost(request, `/api/approvals/${created.id}/reject`, {});
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/comment/i);
  });

  test('C13: 400 when reject comment is whitespace only', async ({ request }) => {
    const created = await createApproval(request, { suffix: 'c13-reject-blank' });
    const res = await apost(request, `/api/approvals/${created.id}/reject`, { comment: '   ' });
    expect(res.status()).toBe(400);
  });

  test('C14: re-rejecting a REJECTED row is idempotent-200 ({idempotent:true})', async ({ request }) => {
    const created = await createApproval(request, { suffix: 'c14-double-reject' });
    const first = await apost(request, `/api/approvals/${created.id}/reject`, {
      comment: `${RUN_TAG} first reject`,
    });
    expect(first.status()).toBe(200);
    const second = await apost(request, `/api/approvals/${created.id}/reject`, {
      comment: `${RUN_TAG} second reject`,
    });
    expect(second.status()).toBe(200);
    const body = await second.json();
    expect(body.idempotent).toBe(true);
    expect(body.status).toBe('REJECTED');
  });

  test('C15: rejecting an APPROVED row → 422 INVALID_APPROVAL_TRANSITION', async ({ request }) => {
    const created = await createApproval(request, { suffix: 'c15-cross-state-reject' });
    const apr = await apost(request, `/api/approvals/${created.id}/approve`, {});
    expect(apr.status()).toBe(200);
    const res = await apost(request, `/api/approvals/${created.id}/reject`, {
      comment: `${RUN_TAG} too late`,
    });
    expect(res.status()).toBe(422);
    const body = await res.json();
    expect(body.code).toBe('INVALID_APPROVAL_TRANSITION');
    expect(body.currentStatus).toBe('APPROVED');
  });
});

// ─── DELETE /:id ──────────────────────────────────────────────────────────

test.describe('Approvals API — DELETE /:id', () => {
  test('C16: 200 {success:true,id} on happy delete (audit row written first)', async ({ request }) => {
    const created = await createApproval(request, { suffix: 'c16-delete' });
    const res = await adel(request, `/api/approvals/${created.id}`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.id).toBe(created.id);
    // Subsequent GET via list should NOT include this id
    const list = await aget(request, '/api/approvals');
    expect(list.status()).toBe(200);
    const rows = await list.json();
    expect(rows.find((r) => r.id === created.id)).toBeUndefined();
    // Already deleted — drop from cleanup
    const idx = createdApprovalIds.indexOf(created.id);
    if (idx >= 0) createdApprovalIds.splice(idx, 1);
  });

  test('C17: 404 when id does not exist in tenant scope', async ({ request }) => {
    const res = await adel(request, '/api/approvals/99999999');
    expect(res.status()).toBe(404);
    const body = await res.json();
    expect(body.error).toMatch(/not found/i);
  });
});

// ─── Auth gate ────────────────────────────────────────────────────────────

test.describe('Approvals API — auth gate', () => {
  test('C18: GET / without token → 401/403', async ({ request }) => {
    const res = await request.get(`${BASE_URL}/api/approvals`);
    expect([401, 403]).toContain(res.status());
  });

  test('C18: POST / without token → 401/403', async ({ request }) => {
    const res = await request.post(`${BASE_URL}/api/approvals`, {
      data: { entity: 'Deal', entityId: 1 },
      headers: { 'Content-Type': 'application/json' },
    });
    expect([401, 403]).toContain(res.status());
  });

  test('C18: POST /:id/approve without token → 401/403', async ({ request }) => {
    const res = await request.post(`${BASE_URL}/api/approvals/1/approve`, {
      data: {},
      headers: { 'Content-Type': 'application/json' },
    });
    expect([401, 403]).toContain(res.status());
  });

  test('C18: POST /:id/reject without token → 401/403', async ({ request }) => {
    const res = await request.post(`${BASE_URL}/api/approvals/1/reject`, {
      data: { comment: 'x' },
      headers: { 'Content-Type': 'application/json' },
    });
    expect([401, 403]).toContain(res.status());
  });

  test('C18: DELETE /:id without token → 401/403', async ({ request }) => {
    const res = await request.delete(`${BASE_URL}/api/approvals/1`);
    expect([401, 403]).toContain(res.status());
  });

  test('C18: GET /pending-count without token → 401/403', async ({ request }) => {
    const res = await request.get(`${BASE_URL}/api/approvals/pending-count`);
    expect([401, 403]).toContain(res.status());
  });
});

// ─── Cross-tenant isolation ───────────────────────────────────────────────

test.describe('Approvals API — cross-tenant isolation', () => {
  test('C19: approval id from generic tenant must 404 from wellness admin', async ({ request }) => {
    const created = await createApproval(request, { suffix: 'c19-cross-tenant' });
    const { token } = await getWellnessAdmin(request);
    if (!token) test.skip(true, 'wellness admin login unavailable on this stack');
    // Try to approve the generic-tenant approval as wellness admin — must 404
    // (NOT 403 — verifyRole passes since wellness admin IS ADMIN, but the
    // tenant-scoped findFirst returns null so the route 404s).
    const res = await post(request, token, `/api/approvals/${created.id}/approve`, {});
    expect(res.status()).toBe(404);
    const body = await res.json();
    expect(body.error).toMatch(/not found/i);
  });
});
