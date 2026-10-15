// @ts-check
/**
 * Unit tests for DELETE /api/auth/me/account — self-service account deletion
 * (privacy policy §10.1). Sibling of auth.test.js; same prisma-singleton
 * monkey-patch + supertest pattern (patch BEFORE requiring the router).
 *
 * Contracts pinned here
 * ─────────────────────
 *   - 401 without Authorization header (verifyToken gate)
 *   - 400 CONFIRMATION_REQUIRED when confirmDestructive !== true
 *   - 400 PASSWORD_REQUIRED when a password account omits the password
 *   - 400 PASSWORD_INCORRECT on bcrypt mismatch
 *   - 400 TOTP_REQUIRED when 2FA is enabled and no/invalid code supplied
 *   - admin deletion requires a selected active successor admin
 *   - admin-owned operational records transfer before account deletion
 *   - 200 user-scope happy path: audit BEFORE delete, prisma.user.delete,
 *     jti revoked with reason 'account_deleted', { ok:true, deleted:'user' }
 *   - tenant data is never deleted by self-service account deletion
 *   - 200 SSO account: no password required (unusable random hash —
 *     see routes/sso.js), confirmDestructive is the bar
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import speakeasy from 'speakeasy';

import prisma from '../../lib/prisma.js';

// ── prisma singleton patch (BEFORE the router is required) ───────────
prisma.user = {
  findUnique: vi.fn(),
  findFirst: vi.fn(),
  findMany: vi.fn().mockResolvedValue([]),
  count: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  updateMany: vi.fn().mockResolvedValue({ count: 0 }),
  delete: vi.fn().mockResolvedValue({}),
};
prisma.tenant = {
  findUnique: vi.fn().mockResolvedValue(null),
  findMany: vi.fn().mockResolvedValue([]),
  create: vi.fn(),
  delete: vi.fn().mockResolvedValue({}),
};
prisma.auditLog = {
  findFirst: vi.fn().mockResolvedValue(null),
  create: vi.fn().mockResolvedValue({}),
};
prisma.revokedToken = {
  findUnique: vi.fn().mockResolvedValue(null),
  upsert: vi.fn().mockResolvedValue({}),
  findMany: vi.fn().mockResolvedValue([]),
};
prisma.smsConfig = {
  findFirst: vi.fn().mockResolvedValue(null),
};
prisma.userRole = {
  count: vi.fn().mockResolvedValue(1),
  findUnique: vi.fn().mockResolvedValue(null),
  findFirst: vi.fn().mockResolvedValue(null),
  findMany: vi.fn().mockResolvedValue([]),
  create: vi.fn().mockResolvedValue({}),
  upsert: vi.fn().mockResolvedValue({}),
};
prisma.role = {
  findFirst: vi.fn().mockResolvedValue({ id: 999 }),
  create: vi.fn().mockResolvedValue({ id: 999 }),
};
prisma.rolePermission = {
  findFirst: vi.fn().mockResolvedValue({ id: 999 }),
  create: vi.fn().mockResolvedValue({}),
};
prisma.roleWidget = {
  create: vi.fn().mockResolvedValue({}),
};
for (const model of [
  'contact', 'webForm', 'savedContactView', 'deal', 'ticket', 'task',
  'expense', 'project', 'reportSchedule', 'whatsAppThread', 'landingPage',
  'travelQuote', 'salesTeam', 'webhookCredential', 'shift',
]) {
  prisma[model] = { updateMany: vi.fn().mockResolvedValue({ count: 0 }) };
}
prisma.salesTeamMember = {
  findMany: vi.fn().mockResolvedValue([]),
  createMany: vi.fn().mockResolvedValue({ count: 0 }),
};
prisma.$transaction = vi.fn();
prisma.$queryRaw = vi.fn();

import express from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { createRequire } from 'node:module';
const requireCJS = createRequire(import.meta.url);
const authRouter = requireCJS('../../routes/auth');

const JWT_SECRET = process.env.JWT_SECRET || 'enterprise_super_secret_key_2026';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/auth', authRouter);
  return app;
}

function bearer({ userId = 7, tenantId = 1, role = 'USER', jti } = {}) {
  const payload = { userId, tenantId, role, userType: 'STAFF', isOwner: false };
  if (jti) payload.jti = jti;
  return 'Bearer ' + jwt.sign(payload, JWT_SECRET, { expiresIn: '5m' });
}

const PASSWORD = 'correct-horse-battery';
const HASHED = bcrypt.hashSync(PASSWORD, 4);

function baseUser(overrides = {}) {
  return {
    id: 7,
    tenantId: 1,
    email: 'member@acme.test',
    name: 'Member',
    role: 'USER',
    password: HASHED,
    ssoProvider: null,
    twoFactorEnabled: false,
    twoFactorSecret: null,
    deactivatedAt: null,
    ...overrides,
  };
}

describe('DELETE /api/auth/me/account', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prisma.revokedToken.findUnique.mockResolvedValue(null);
    prisma.revokedToken.upsert.mockResolvedValue({});
    prisma.auditLog.findFirst.mockResolvedValue(null);
    prisma.auditLog.create.mockResolvedValue({});
    prisma.user.delete.mockResolvedValue({});
    prisma.tenant.delete.mockResolvedValue({});
    prisma.$transaction.mockImplementation(async (callback) => callback(prisma));
    prisma.$queryRaw.mockReset().mockResolvedValue([
      { id: 7, role: 'ADMIN', deactivatedAt: null },
      { id: 8, role: 'ADMIN', deactivatedAt: null },
    ]);
  });

  afterEach(() => {
    // Self-service account deletion must never remove the organization,
    // regardless of success, validation failure, role, or tenant size.
    expect(prisma.tenant.delete).not.toHaveBeenCalled();
  });

  test('401 without Authorization header', async () => {
    const res = await request(makeApp())
      .delete('/api/auth/me/account')
      .send({ confirmDestructive: true, password: PASSWORD });
    expect(res.status).toBe(401);
  });

  test('400 CONFIRMATION_REQUIRED when confirmDestructive flag is missing', async () => {
    prisma.user.findFirst.mockResolvedValue(baseUser());
    const res = await request(makeApp())
      .delete('/api/auth/me/account')
      .set('Authorization', bearer())
      .send({ password: PASSWORD });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('CONFIRMATION_REQUIRED');
    expect(prisma.user.delete).not.toHaveBeenCalled();
    expect(prisma.tenant.delete).not.toHaveBeenCalled();
  });

  test('400 PASSWORD_REQUIRED when password account omits password', async () => {
    prisma.user.findFirst.mockResolvedValue(baseUser());
    const res = await request(makeApp())
      .delete('/api/auth/me/account')
      .set('Authorization', bearer())
      .send({ confirmDestructive: true });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('PASSWORD_REQUIRED');
    expect(prisma.user.delete).not.toHaveBeenCalled();
  });

  test('400 PASSWORD_INCORRECT on wrong password', async () => {
    prisma.user.findFirst.mockResolvedValue(baseUser());
    const res = await request(makeApp())
      .delete('/api/auth/me/account')
      .set('Authorization', bearer())
      .send({ confirmDestructive: true, password: 'not-the-password' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('PASSWORD_INCORRECT');
    expect(prisma.user.delete).not.toHaveBeenCalled();
  });

  test('400 TOTP_REQUIRED when 2FA enabled and no code supplied', async () => {
    const secret = speakeasy.generateSecret({ length: 20 }).base32;
    prisma.user.findFirst.mockResolvedValue(
      baseUser({ twoFactorEnabled: true, twoFactorSecret: secret }),
    );
    const res = await request(makeApp())
      .delete('/api/auth/me/account')
      .set('Authorization', bearer())
      .send({ confirmDestructive: true, password: PASSWORD });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('TOTP_REQUIRED');
    expect(prisma.user.delete).not.toHaveBeenCalled();
  });

  test('200 with valid TOTP code when 2FA enabled', async () => {
    const secret = speakeasy.generateSecret({ length: 20 }).base32;
    prisma.user.findFirst.mockResolvedValue(
      baseUser({ twoFactorEnabled: true, twoFactorSecret: secret }),
    );
    const code = speakeasy.totp({ secret, encoding: 'base32' });
    const res = await request(makeApp())
      .delete('/api/auth/me/account')
      .set('Authorization', bearer())
      .send({ confirmDestructive: true, password: PASSWORD, code });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, deleted: 'user' });
    expect(prisma.user.delete).toHaveBeenCalledWith({ where: { id: 7 } });
  });

  test('400 SUCCESSOR_ADMIN_REQUIRED when an admin does not select a successor', async () => {
    prisma.user.findFirst.mockResolvedValue(baseUser({ role: 'ADMIN' }));
    const res = await request(makeApp())
      .delete('/api/auth/me/account')
      .set('Authorization', bearer({ role: 'ADMIN' }))
      .send({ confirmDestructive: true, password: PASSWORD });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('SUCCESSOR_ADMIN_REQUIRED');
    expect(prisma.user.delete).not.toHaveBeenCalled();
    expect(prisma.tenant.delete).not.toHaveBeenCalled();
  });

  test('200 user-scope happy path: audit + delete + jti revocation', async () => {
    prisma.user.findFirst.mockResolvedValue(baseUser());
    const res = await request(makeApp())
      .delete('/api/auth/me/account')
      .set('Authorization', bearer({ jti: 'jti-del-1' }))
      .send({ confirmDestructive: true, password: PASSWORD });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, deleted: 'user' });
    expect(prisma.user.delete).toHaveBeenCalledWith({ where: { id: 7 } });
    expect(prisma.tenant.delete).not.toHaveBeenCalled();
    // audit row written (writeAudit goes through prisma.auditLog.create)
    expect(prisma.auditLog.create).toHaveBeenCalled();
    // session killed server-side
    expect(prisma.revokedToken.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { jti: 'jti-del-1' },
        create: expect.objectContaining({ reason: 'account_deleted', userId: 7 }),
      }),
    );
  });

  test('409 SUCCESSOR_ADMIN_INVALID when the selected user is not another active admin', async () => {
    prisma.user.findFirst
      .mockResolvedValueOnce(baseUser({ role: 'ADMIN' }))
      .mockResolvedValueOnce(null);
    const res = await request(makeApp())
      .delete('/api/auth/me/account')
      .set('Authorization', bearer({ role: 'ADMIN' }))
      .send({ confirmDestructive: true, password: PASSWORD, successorAdminId: 8 });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('SUCCESSOR_ADMIN_INVALID');
    expect(res.body.error).toContain('selected successor');
    expect(prisma.tenant.delete).not.toHaveBeenCalled();
    expect(prisma.user.delete).not.toHaveBeenCalled();
  });

  test('200 transfers admin permissions and assigned data to the selected successor', async () => {
    prisma.user.findFirst
      .mockResolvedValueOnce(baseUser({ role: 'ADMIN' }))
      .mockResolvedValueOnce({ id: 8, name: 'Successor', email: 'successor@acme.test' });
    prisma.contact.updateMany.mockResolvedValueOnce({ count: 3 });
    prisma.deal.updateMany.mockResolvedValueOnce({ count: 2 });
    prisma.salesTeamMember.findMany.mockResolvedValueOnce([
      { teamId: 21 },
      { teamId: 22 },
    ]);
    const res = await request(makeApp())
      .delete('/api/auth/me/account')
      .set('Authorization', bearer({ role: 'ADMIN' }))
      .send({ confirmDestructive: true, password: PASSWORD, successorAdminId: 8 });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ok: true,
      deleted: 'user',
      successorAdminId: 8,
      transferredRecords: 5,
    });
    expect(prisma.userRole.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: { userId: 8, roleId: 999 },
    }));
    expect(prisma.contact.updateMany).toHaveBeenCalledWith({
      where: { tenantId: 1, assignedToId: 7 },
      data: { assignedToId: 8 },
    });
    expect(prisma.deal.updateMany).toHaveBeenCalledWith({
      where: { tenantId: 1, ownerId: 7 },
      data: { ownerId: 8 },
    });
    expect(prisma.salesTeamMember.createMany).toHaveBeenCalledWith({
      data: [
        { tenantId: 1, teamId: 21, userId: 8 },
        { tenantId: 1, teamId: 22, userId: 8 },
      ],
      skipDuplicates: true,
    });
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(2);
    expect(prisma.webhookCredential.updateMany).toHaveBeenCalledWith({
      where: { tenantId: 1, createdById: 7 }, data: { createdById: 8 },
    });
    expect(prisma.shift.updateMany).toHaveBeenCalledWith({
      where: { tenantId: 1, userId: 7 }, data: { userId: 8 },
    });
    expect(prisma.user.delete).toHaveBeenCalledWith({ where: { id: 7 } });
    expect(prisma.tenant.delete).not.toHaveBeenCalled();
  });

  test.each([
    { successors: [] },
    { successors: [{ id: 8, role: 'USER', deactivatedAt: null }] },
    { successors: [{ id: 8, role: 'ADMIN', deactivatedAt: new Date() }] },
  ])('409 rejects a successor changed after initial validation (%j)', async ({ successors }) => {
    prisma.user.findFirst
      .mockResolvedValueOnce(baseUser({ role: 'ADMIN' }))
      .mockResolvedValueOnce({ id: 8, name: 'Successor', email: 'successor@acme.test' });
    prisma.$queryRaw.mockResolvedValueOnce([{ id: 1 }]).mockResolvedValueOnce([
      { id: 7, role: 'ADMIN', deactivatedAt: null }, ...successors,
    ]);
    const res = await request(makeApp()).delete('/api/auth/me/account')
      .set('Authorization', bearer({ role: 'ADMIN' }))
      .send({ confirmDestructive: true, password: PASSWORD, successorAdminId: 8 });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('SUCCESSOR_ADMIN_INVALID');
    expect(prisma.user.delete).not.toHaveBeenCalled();
    expect(prisma.shift.updateMany).not.toHaveBeenCalled();
    expect(prisma.webhookCredential.updateMany).not.toHaveBeenCalled();
  });

  test('500 leaves the admin undeleted when successor data transfer fails', async () => {
    prisma.user.findFirst
      .mockResolvedValueOnce(baseUser({ role: 'ADMIN' }))
      .mockResolvedValueOnce({ id: 8, name: 'Successor', email: 'successor@acme.test' });
    prisma.$transaction.mockRejectedValueOnce(new Error('transfer failed'));

    const res = await request(makeApp())
      .delete('/api/auth/me/account')
      .set('Authorization', bearer({ role: 'ADMIN' }))
      .send({ confirmDestructive: true, password: PASSWORD, successorAdminId: 8 });

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Failed to delete account' });
    expect(prisma.user.delete).not.toHaveBeenCalled();
    expect(prisma.revokedToken.upsert).not.toHaveBeenCalled();
  });

  test('200 SSO account deletes without a password', async () => {
    prisma.user.findFirst.mockResolvedValue(
      baseUser({ ssoProvider: 'google', password: 'unusable-random-hash' }),
    );
    const res = await request(makeApp())
      .delete('/api/auth/me/account')
      .set('Authorization', bearer())
      .send({ confirmDestructive: true });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, deleted: 'user' });
    expect(prisma.user.delete).toHaveBeenCalledWith({ where: { id: 7 } });
  });
});
