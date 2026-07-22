// @ts-check
/**
 * Unit + integration tests for backend/routes/staff.js — pins the new
 * row-action endpoints introduced for #618 (Staff Directory row actions)
 * and the deactivatedAt surface that powers the Inactive-badge UI.
 *
 * Issue context
 * ─────────────
 *   #618 — Settings → Staff directory rendered name/email/role/created-at
 *          plus a single Delete button. There was no way to edit a row,
 *          temporarily disable a user without deleting them, force-rotate
 *          a password, or re-send a stale invite. Admins resorted to
 *          editing the database directly. This commit adds:
 *            PUT    /api/staff/:id              — edit name/email/role/wellnessRole
 *            PATCH  /api/staff/:id              — { active: bool } toggle
 *            POST   /api/staff/:id/reset-password
 *            POST   /api/staff/:id/resend-invite
 *
 * What this file pins
 * ───────────────────
 *   1. PUT /:id updates only changed fields, writes a User/EDIT audit row.
 *   2. PUT /:id with no real diff returns 200 + the current row, no audit.
 *   3. PUT /:id rejects an unknown role with 400.
 *   4. PUT /:id refuses to demote the calling admin's own ADMIN row.
 *   5. PUT /:id surfaces Prisma P2002 (unique email collision) as 409.
 *   6. PATCH /:id { active: false } sets deactivatedAt + writes DEACTIVATE audit.
 *   7. PATCH /:id { active: true } clears deactivatedAt + writes REACTIVATE audit.
 *   8. PATCH /:id refuses to deactivate the caller's own row (400).
 *   9. PATCH /:id with non-boolean `active` returns 400.
 *  10. POST /:id/reset-password issues a hex-32 token, stores it in the
 *      __testHooks.adminResetTokens map, returns 200 + tokenIssued=true.
 *      The raw token is NEVER echoed in the response body (#526 hardening
 *      precedent — admin-trigger flows must not leak the token client-side
 *      because the client is the admin, not the recipient).
 *  11. POST /:id/resend-invite issues a 24-hour token in the inviteTokens
 *      map, returns 200 + INVITE_RESENT.
 *  12. All four endpoints scope by req.user.tenantId — a cross-tenant id
 *      returns 404, never 200.
 *
 * Test pattern mirrors backend/test/routes/communications.test.js (prisma
 * singleton monkey-patch + supertest with a fake auth middleware).
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import bcrypt from 'bcryptjs';

import prisma from '../../lib/prisma.js';

prisma.user = {
  findFirst: vi.fn(),
  findMany: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
};
prisma.userRole = {
  findFirst: vi.fn().mockResolvedValue(null),
  deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
  create: vi.fn().mockResolvedValue({}),
};
prisma.auditLog = {
  create: vi.fn().mockResolvedValue({}),
};
// T30 (Class B2 from docs/gaps/backend-test-routes-red-audit.md) —
// routes/staff.js:49 getCallerVertical() reads tenant.findUnique to
// decide whether wellnessRole validation should consult the per-tenant
// catalog (wellness) or the legacy whitelist (generic). Without this
// mock the route reaches the real DB connection string, can't connect,
// and the wellnessRole-enum-validation tests time out at 5s.
prisma.tenant = {
  findUnique: vi.fn(),
};
// PUT /:id wraps the User.update + UserRole swap in prisma.$transaction.
// Passthrough so the callback receives `prisma` itself as `tx`, and the
// mocked tx.user.update / tx.userRole.* hits the same mocks above.
prisma.$transaction = vi.fn(async (cb) => cb(prisma));

import express from 'express';
import request from 'supertest';
import { createRequire } from 'node:module';
const requireCJS = createRequire(import.meta.url);
const staffRouter = requireCJS('../../routes/staff');

function makeApp({ tenantId = 1, userId = 7, role = 'ADMIN' } = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { userId, tenantId, role };
    next();
  });
  app.use('/api/staff', staffRouter);
  return app;
}

beforeEach(() => {
  prisma.user.findFirst.mockReset();
  prisma.user.findMany.mockReset();
  prisma.user.update.mockReset();
  prisma.user.delete.mockReset();
  prisma.auditLog.create.mockReset();
  prisma.auditLog.create.mockResolvedValue({});
  // Clear in-memory token stores between tests so cardinality assertions
  // (size after issue) are deterministic.
  staffRouter.__testHooks.adminResetTokens.clear();
  staffRouter.__testHooks.inviteTokens.clear();
});

// ── PUT /:id — edit user fields (#618) ─────────────────────────────

describe('PUT /:id — edit', () => {
  test('updates only changed fields and writes EDIT audit', async () => {
    prisma.user.findFirst.mockResolvedValue({
      id: 22, tenantId: 1, name: 'Old Name', email: 'old@x.com',
      role: 'USER', wellnessRole: null, createdAt: new Date('2026-01-01'), deactivatedAt: null,
    });
    prisma.user.update.mockResolvedValue({
      id: 22, email: 'old@x.com', name: 'New Name', role: 'USER',
      wellnessRole: null, createdAt: new Date('2026-01-01'), deactivatedAt: null,
    });

    const res = await request(makeApp()).put('/api/staff/22').send({ name: 'New Name' });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('New Name');

    expect(prisma.user.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 22 },
      data: { name: 'New Name' },
    }));
    expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
    const auditArgs = prisma.auditLog.create.mock.calls[0][0];
    expect(auditArgs.data.action).toBe('EDIT');
    expect(auditArgs.data.entity).toBe('User');
  });

  test('manual password change is hashed and persisted on PUT /:id', async () => {
    prisma.user.findFirst.mockResolvedValue({
      id: 22, tenantId: 1, name: 'Old Name', email: 'old@x.com',
      role: 'USER', wellnessRole: null, createdAt: new Date('2026-01-01'), deactivatedAt: null,
    });
    prisma.user.update.mockImplementation(async ({ data }) => ({
      id: 22,
      email: 'old@x.com',
      name: 'Old Name',
      role: 'USER',
      wellnessRole: null,
      createdAt: new Date('2026-01-01'),
      deactivatedAt: null,
    }));

    const res = await request(makeApp())
      .put('/api/staff/22')
      .send({ password: 'ManualPw!234' });

    expect(res.status).toBe(200);
    expect(prisma.user.update).toHaveBeenCalledTimes(1);
    const updateArgs = prisma.user.update.mock.calls[0][0];
    expect(updateArgs.data.password).toBeDefined();
    expect(updateArgs.data.password).not.toBe('ManualPw!234');
    expect(await bcrypt.compare('ManualPw!234', updateArgs.data.password)).toBe(true);
    expect(res.body).not.toHaveProperty('password');
    const auditArgs = prisma.auditLog.create.mock.calls[0][0];
    const details = JSON.parse(auditArgs.data.details);
    expect(details.changed.password).toEqual({ updated: true });
  });

  test('no-op edit returns 200 + current row, no audit', async () => {
    prisma.user.findFirst.mockResolvedValue({
      id: 22, tenantId: 1, name: 'Same', email: 'same@x.com',
      role: 'USER', wellnessRole: null, createdAt: new Date('2026-01-01'), deactivatedAt: null,
    });
    const res = await request(makeApp()).put('/api/staff/22').send({ name: 'Same' });
    expect(res.status).toBe(200);
    expect(prisma.user.update).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  test('rejects unknown role with 400', async () => {
    prisma.user.findFirst.mockResolvedValue({
      id: 22, tenantId: 1, name: 'X', email: 'x@x.com', role: 'USER', wellnessRole: null,
    });
    const res = await request(makeApp()).put('/api/staff/22').send({ role: 'GOD' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Invalid role/);
  });

  test('refuses self-demotion of own ADMIN row', async () => {
    prisma.user.findFirst.mockResolvedValue({
      id: 7, tenantId: 1, name: 'Me', email: 'me@x.com', role: 'ADMIN', wellnessRole: null,
    });
    const res = await request(makeApp({ userId: 7 })).put('/api/staff/7').send({ role: 'USER' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/own role/);
  });

  test('surfaces Prisma P2002 collision as 409', async () => {
    prisma.user.findFirst.mockResolvedValue({
      id: 22, tenantId: 1, name: 'X', email: 'old@x.com', role: 'USER', wellnessRole: null,
    });
    const err = new Error('Unique constraint');
    err.code = 'P2002';
    prisma.user.update.mockRejectedValue(err);

    const res = await request(makeApp()).put('/api/staff/22').send({ email: 'taken@x.com' });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/Email/);
  });

  test('cross-tenant id returns 404', async () => {
    prisma.user.findFirst.mockResolvedValue(null);
    const res = await request(makeApp()).put('/api/staff/9999').send({ name: 'whatever' });
    expect(res.status).toBe(404);
  });
});

// ── PATCH /:id — deactivate / reactivate (#618) ────────────────────

describe('PATCH /:id — deactivate', () => {
  test('{ active: false } sets deactivatedAt + writes DEACTIVATE audit', async () => {
    prisma.user.findFirst.mockResolvedValue({
      id: 22, tenantId: 1, email: 'x@x.com', role: 'USER', deactivatedAt: null,
    });
    prisma.user.update.mockResolvedValue({
      id: 22, email: 'x@x.com', name: 'X', role: 'USER', wellnessRole: null,
      createdAt: new Date(), deactivatedAt: new Date(),
    });

    const res = await request(makeApp()).patch('/api/staff/22').send({ active: false });
    expect(res.status).toBe(200);
    expect(res.body.deactivatedAt).toBeTruthy();

    const updateArgs = prisma.user.update.mock.calls[0][0];
    expect(updateArgs.data.deactivatedAt).toBeInstanceOf(Date);

    expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
    expect(prisma.auditLog.create.mock.calls[0][0].data.action).toBe('DEACTIVATE');
  });

  test('{ active: true } clears deactivatedAt + writes REACTIVATE audit', async () => {
    prisma.user.findFirst.mockResolvedValue({
      id: 22, tenantId: 1, email: 'x@x.com', role: 'USER', deactivatedAt: new Date(),
    });
    prisma.user.update.mockResolvedValue({
      id: 22, email: 'x@x.com', name: 'X', role: 'USER', wellnessRole: null,
      createdAt: new Date(), deactivatedAt: null,
    });

    const res = await request(makeApp()).patch('/api/staff/22').send({ active: true });
    expect(res.status).toBe(200);
    expect(res.body.deactivatedAt).toBeNull();

    const updateArgs = prisma.user.update.mock.calls[0][0];
    expect(updateArgs.data.deactivatedAt).toBeNull();
    expect(prisma.auditLog.create.mock.calls[0][0].data.action).toBe('REACTIVATE');
  });

  test('refuses self-deactivation', async () => {
    const res = await request(makeApp({ userId: 7 })).patch('/api/staff/7').send({ active: false });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/own account/);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  test('non-boolean `active` returns 400', async () => {
    const res = await request(makeApp()).patch('/api/staff/22').send({ active: 'yes' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/active: boolean/);
  });

  test('cross-tenant id returns 404', async () => {
    prisma.user.findFirst.mockResolvedValue(null);
    const res = await request(makeApp()).patch('/api/staff/9999').send({ active: false });
    expect(res.status).toBe(404);
  });
});

// ── PRD_WELLNESS_RBAC DD-5.1 [RESOLVED 2026-05-24] — cashier wellnessRole ──

describe('PUT /:id — wellnessRole enum (PRD_WELLNESS_RBAC DD-5.1)', () => {
  beforeEach(() => {
    // T30: stub the vertical-resolution lookup so getCallerVertical()
    // (routes/staff.js:49) doesn't try to reach the real DB and time out.
    // Resolve to 'generic' so validateWellnessRole hits the
    // LEGACY_WELLNESS_ROLES whitelist branch (which includes "cashier"
    // per DD-5.1) — that path needs zero further mocks. The wellness
    // branch would additionally require mocking prisma.wellnessRoleType
    // because isCatalogedKey() queries the per-tenant catalog. Either
    // branch satisfies these two cases identically because "cashier" is
    // valid in the whitelist AND seeded in the wellness catalog.
    prisma.tenant.findUnique.mockResolvedValue({ id: 1, vertical: 'generic' });
  });

  test('accepts "cashier" as a valid wellnessRole (POS sales role)', async () => {
    prisma.user.findFirst.mockResolvedValue({
      id: 22, tenantId: 1, email: 'cashier@x.com', name: 'C', role: 'USER', wellnessRole: null,
    });
    prisma.user.update.mockResolvedValue({
      id: 22, email: 'cashier@x.com', name: 'C', role: 'USER', wellnessRole: 'cashier',
      createdAt: new Date(), deactivatedAt: null,
    });

    const res = await request(makeApp()).put('/api/staff/22').send({ wellnessRole: 'cashier' });
    expect(res.status).toBe(200);
    expect(res.body.wellnessRole).toBe('cashier');

    const updateArgs = prisma.user.update.mock.calls[0][0];
    expect(updateArgs.data.wellnessRole).toBe('cashier');
  });

  test('rejects garbage wellnessRole with 400 + listed enum values', async () => {
    prisma.user.findFirst.mockResolvedValue({
      id: 22, tenantId: 1, email: 'x@x.com', name: 'X', role: 'USER', wellnessRole: null,
    });

    const res = await request(makeApp()).put('/api/staff/22').send({ wellnessRole: 'janitor' });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('cashier'); // the new value should appear in the enum list
  });
});

// ── POST /:id/reset-password (#618) ────────────────────────────────

describe('POST /:id/reset-password', () => {
  test('issues a hex-32 token, never returns it in the body', async () => {
    prisma.user.findFirst.mockResolvedValue({
      id: 22, tenantId: 1, email: 'x@x.com', role: 'USER',
    });
    const res = await request(makeApp()).post('/api/staff/22/reset-password').send({});
    expect(res.status).toBe(200);
    expect(res.body.code).toBe('PASSWORD_RESET_LINK_SENT');
    expect(res.body.tokenIssued).toBe(true);
    // Critical: the raw token must never be echoed back to the admin.
    expect(JSON.stringify(res.body)).not.toMatch(/[a-f0-9]{64}/);

    expect(staffRouter.__testHooks.adminResetTokens.size).toBe(1);
    const [token, entry] = [...staffRouter.__testHooks.adminResetTokens.entries()][0];
    expect(token).toMatch(/^[a-f0-9]{64}$/);
    expect(entry.userId).toBe(22);
    expect(entry.expiresAt).toBeGreaterThan(Date.now());

    expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
    expect(prisma.auditLog.create.mock.calls[0][0].data.action).toBe('PASSWORD_RESET');
  });

  test('cross-tenant id returns 404', async () => {
    prisma.user.findFirst.mockResolvedValue(null);
    const res = await request(makeApp()).post('/api/staff/9999/reset-password').send({});
    expect(res.status).toBe(404);
    expect(staffRouter.__testHooks.adminResetTokens.size).toBe(0);
  });

  test('invalid id returns 400', async () => {
    const res = await request(makeApp()).post('/api/staff/abc/reset-password').send({});
    expect(res.status).toBe(400);
  });
});

// ── POST /:id/resend-invite (#618) ─────────────────────────────────

describe('POST /:id/resend-invite', () => {
  test('issues a 24-hour token, returns INVITE_RESENT, writes audit', async () => {
    prisma.user.findFirst.mockResolvedValue({
      id: 22, tenantId: 1, email: 'x@x.com', role: 'USER',
    });
    const before = Date.now();
    const res = await request(makeApp()).post('/api/staff/22/resend-invite').send({});
    expect(res.status).toBe(200);
    expect(res.body.code).toBe('INVITE_RESENT');

    expect(staffRouter.__testHooks.inviteTokens.size).toBe(1);
    const [, entry] = [...staffRouter.__testHooks.inviteTokens.entries()][0];
    // 24-hour TTL → expiresAt should be ~24h after issuance, well above 1h.
    expect(entry.expiresAt).toBeGreaterThan(before + 23 * 3600000);

    expect(prisma.auditLog.create.mock.calls[0][0].data.action).toBe('INVITE_RESEND');
  });

  test('cross-tenant id returns 404', async () => {
    prisma.user.findFirst.mockResolvedValue(null);
    const res = await request(makeApp()).post('/api/staff/9999/resend-invite').send({});
    expect(res.status).toBe(404);
  });
});

// ── GET /api/staff?fields=summary — opt-in slim shape (#920 slice 15) ─────
//
// Mirrors slices 1-14 (contacts/deals/tickets/notifications/projects/tasks/
// expenses/playbooks/sequences/surveys/email-templates/knowledge-base/etc.).
// When ?fields=summary on GET /api/staff, Prisma is called with an explicit
// slim `select` that drops commissionProfileId — the only field that
// dropdown / picker callers don't need. Sensitive fields (password,
// twoFactorSecret, backupCodes, ssoProvider/googleId/microsoftId,
// emailSignature, trial dates) are NEVER returned in either branch because
// the full shape already used an explicit select that omits them — slim is
// purely additive PII-reduction for callers that don't need commission FK.
// ADDITIVE: absent ?fields preserves the full select.

describe('GET /api/staff?fields=summary — opt-in slim shape (#920 slice 15)', () => {
  test('default (no ?fields) → prisma.user.findMany called with FULL select including commissionProfileId', async () => {
    prisma.user.findMany.mockResolvedValue([]);
    const res = await request(makeApp()).get('/api/staff');
    expect(res.status).toBe(200);
    const args = prisma.user.findMany.mock.calls[0][0];
    expect(args.select).toEqual(expect.objectContaining({
      id: true,
      email: true,
      name: true,
      role: true,
      wellnessRole: true,
      commissionProfileId: true,
      createdAt: true,
      deactivatedAt: true,
    }));
    // Never include the sensitive fields in either branch.
    expect(args.select.password).toBeUndefined();
    expect(args.select.twoFactorSecret).toBeUndefined();
    expect(args.select.backupCodes).toBeUndefined();
  });

  test('?fields=summary → prisma.user.findMany called with SLIM select (commissionProfileId DROPPED)', async () => {
    prisma.user.findMany.mockResolvedValue([]);
    const res = await request(makeApp()).get('/api/staff?fields=summary');
    expect(res.status).toBe(200);
    const args = prisma.user.findMany.mock.calls[0][0];
    expect(args.select).toEqual({
      id: true,
      email: true,
      name: true,
      role: true,
      wellnessRole: true,
      tenantId: true,
      createdAt: true,
      deactivatedAt: true,
    });
    expect(args.select.commissionProfileId).toBeUndefined();
    // Sanity: ensure no `include` snuck in alongside select.
    expect(args.include).toBeUndefined();
  });

  test('?fields=summary → response rows expose ONLY the slim-shape keys (no sensitive fields, no commissionProfileId)', async () => {
    prisma.user.findMany.mockResolvedValue([
      {
        id: 12,
        email: 'doctor@enhancedwellness.in',
        name: 'Dr Harsh Mehta',
        role: 'USER',
        wellnessRole: 'doctor',
        tenantId: 1,
        createdAt: new Date('2026-01-15'),
        deactivatedAt: null,
      },
    ]);
    const res = await request(makeApp({ role: 'ADMIN' })).get('/api/staff?fields=summary');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(1);
    const row = res.body[0];
    // Slim shape exposes these keys.
    expect(row.id).toBe(12);
    expect(row.name).toBe('Dr Harsh Mehta');
    expect(row.email).toBe('doctor@enhancedwellness.in');
    expect(row.role).toBe('USER');
    expect(row.wellnessRole).toBe('doctor');
    // Slim shape DROPS commissionProfileId.
    expect(row).not.toHaveProperty('commissionProfileId');
    // Sensitive fields were never present in either shape — pin defence.
    expect(row).not.toHaveProperty('password');
    expect(row).not.toHaveProperty('twoFactorSecret');
    expect(row).not.toHaveProperty('backupCodes');
    expect(row).not.toHaveProperty('googleId');
    expect(row).not.toHaveProperty('microsoftId');
    expect(row).not.toHaveProperty('ssoProvider');
  });

  test('?fields=summary preserves tenant-isolation — where.tenantId mirrors req.user.tenantId', async () => {
    prisma.user.findMany.mockResolvedValue([]);
    await request(makeApp({ tenantId: 4242 })).get('/api/staff?fields=summary');
    const args = prisma.user.findMany.mock.calls[0][0];
    // Security audit-fix (214017c1): staff list now excludes CUSTOMER
    // role/userType so portal customers never surface in the staff directory.
    expect(args.where).toEqual({
      tenantId: 4242,
      role: { not: 'CUSTOMER' },
      userType: { not: 'CUSTOMER' },
    });
  });

  test('?fields=summary + low-trust viewer (role=USER) → response is still PII-masked (name/email/id masked) — slim does not bypass #682', async () => {
    prisma.user.findMany.mockResolvedValue([
      {
        id: 12,
        email: 'doctor@enhancedwellness.in',
        name: 'Harsh Mehta',
        role: 'USER',
        wellnessRole: 'doctor',
        tenantId: 1,
        createdAt: new Date('2026-01-15'),
        deactivatedAt: null,
      },
    ]);
    // role=USER triggers the shouldMaskForViewer branch.
    const res = await request(makeApp({ role: 'USER', userId: 99 })).get('/api/staff?fields=summary');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    const row = res.body[0];
    // Email is masked to "x****@domain" — first char + ****@ + domain.
    expect(row.email).toMatch(/^d\*+@enhancedwellness\.in$/);
    // Name is masked to "F. Last".
    expect(row.name).toMatch(/^H\. Mehta$/);
    // id is hashed (not the raw 12).
    expect(row.id).not.toBe(12);
  });

  test('?fields=other → falls back to FULL select (additive, only the literal "summary" string opts in)', async () => {
    prisma.user.findMany.mockResolvedValue([]);
    const res = await request(makeApp()).get('/api/staff?fields=other');
    expect(res.status).toBe(200);
    const args = prisma.user.findMany.mock.calls[0][0];
    expect(args.select).toEqual(expect.objectContaining({
      commissionProfileId: true,
    }));
  });
});
