// Unit tests for backend/routes/payment_gateways.js (#848 minimal slice).
//
// Route under test: per-tenant Razorpay BYOK config CRUD.
//   GET    /api/payment-gateways            — list masked configs (ADMIN+MANAGER)
//   PUT    /api/payment-gateways/:provider  — upsert keys (ADMIN), masked-sentinel skip
//   DELETE /api/payment-gateways/:provider  — remove config (ADMIN), idempotent
//
// Surface covered:
//   - GET returns maskConfigRow shape ({configured,last4}) — never plaintext secret
//   - PUT encrypts + stamps lastRotatedAt on a fresh secret; rejects bad provider + bad keyId
//   - PUT skips masked-sentinel echoes (keeps stored secret) — the rotation contract
//   - DELETE removes the row + is idempotent (success even when absent)
//   - RBAC: USER blocked on GET; non-ADMIN blocked on PUT/DELETE
//
// Pattern source: backend/test/routes/payments.test.js — prisma singleton
// monkey-patch before requiring the router (vitest inlines backend/routes via
// config). This route mounts the REAL verifyToken/verifyRole, so we sign a
// real JWT per role (JWT_SECRET pinned in vi.hoisted) rather than faking req.user.
//
// stripDangerous reminder (per CLAUDE.md): the route reads req.params.provider,
// req.body.{keyId,keySecret,isActive} — none are stripped names
// (no id/tenantId/userId/createdAt/updatedAt reads). tenantId comes from
// req.user.tenantId only.
import { describe, test, expect, beforeEach, vi } from 'vitest';
import jwt from 'jsonwebtoken';

// The route uses the REAL verifyToken/verifyRole middleware, so we drive it
// with a real signed JWT. Pin JWT_SECRET BEFORE any import so config/secrets
// (read at module load by middleware/auth) resolves to the same value.
vi.hoisted(() => {
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-payment-gateways';
});

// WELLNESS_FIELD_KEY unset → encryptCredential is a no-op (plaintext), so the
// "encrypted before persist" assertion checks the value was passed through the
// masking helper rather than a specific ciphertext.
import prisma from '../../lib/prisma.js';

prisma.paymentGatewayConfig = prisma.paymentGatewayConfig || {};
prisma.paymentGatewayConfig.findFirst = vi.fn();
prisma.paymentGatewayConfig.findMany = vi.fn();
prisma.paymentGatewayConfig.upsert = vi.fn();
prisma.paymentGatewayConfig.deleteMany = vi.fn();
prisma.auditLog = prisma.auditLog || {};
prisma.auditLog.create = vi.fn().mockResolvedValue({ id: 1 });
prisma.auditLog.findFirst = vi.fn().mockResolvedValue(null);

import express from 'express';
import request from 'supertest';
import { createRequire } from 'node:module';

const requireCJS = createRequire(import.meta.url);
const router = requireCJS('../../routes/payment_gateways');

// Sign a real session JWT (no jti → skips the revoked-token DB lookup).
function tokenFor({ userId = 9, tenantId = 2, role = 'ADMIN' } = {}) {
  return jwt.sign({ userId, tenantId, role }, process.env.JWT_SECRET, {
    expiresIn: '1h',
  });
}

const app = (() => {
  const a = express();
  a.use(express.json());
  a.use('/api/payment-gateways', router);
  return a;
})();

// Helper: issue a supertest request carrying a role-appropriate bearer token.
function authed(method, path, { role = 'ADMIN', tenantId = 2 } = {}) {
  return request(app)[method](path).set(
    'Authorization',
    `Bearer ${tokenFor({ role, tenantId })}`,
  );
}

beforeEach(() => {
  prisma.paymentGatewayConfig.findFirst.mockReset();
  prisma.paymentGatewayConfig.findMany.mockReset();
  prisma.paymentGatewayConfig.upsert.mockReset();
  prisma.paymentGatewayConfig.deleteMany.mockReset();
  prisma.auditLog.create.mockClear();
  prisma.paymentGatewayConfig.findMany.mockResolvedValue([]);
  prisma.paymentGatewayConfig.upsert.mockResolvedValue({
    id: 1, provider: 'razorpay', keyId: 'rzp_test_x',
    keySecret: 'plaintext_secret', webhookSecret: null, isActive: true,
  });
  prisma.paymentGatewayConfig.deleteMany.mockResolvedValue({ count: 1 });
  prisma.paymentGatewayConfig.findFirst.mockResolvedValue({ id: 1 });
});

describe('GET /api/payment-gateways', () => {
  test('returns masked rows — secret never plaintext', async () => {
    prisma.paymentGatewayConfig.findMany.mockResolvedValue([
      { id: 1, provider: 'razorpay', keyId: 'rzp_live_abc', keySecret: 'topsecret', webhookSecret: 'whsecret', isActive: true },
    ]);
    const res = await authed('get', '/api/payment-gateways');
    expect(res.status).toBe(200);
    const row = res.body[0];
    expect(row.keyId).toBe('rzp_live_abc'); // public id NOT masked
    expect(row.keySecret).toEqual({ configured: true, last4: '****cret' });
    // No webhook secret is collected — it is stripped from the response.
    expect(row).not.toHaveProperty('webhookSecret');
    // Raw plaintext secrets must not leak anywhere in the response body.
    expect(JSON.stringify(res.body)).not.toContain('topsecret');
    expect(JSON.stringify(res.body)).not.toContain('whsecret');
  });

  test('scopes findMany to req.user.tenantId', async () => {
    await authed('get', '/api/payment-gateways', { tenantId: 42 });
    expect(prisma.paymentGatewayConfig.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { tenantId: 42 } }),
    );
  });

  test('USER role is forbidden (403)', async () => {
    const res = await authed('get', '/api/payment-gateways', { role: 'USER' });
    expect(res.status).toBe(403);
  });

  test('MANAGER role may read (200)', async () => {
    const res = await authed('get', '/api/payment-gateways', { role: 'MANAGER' });
    expect(res.status).toBe(200);
  });
});

describe('PUT /api/payment-gateways/:provider', () => {
  test('saves fresh keys + stamps lastRotatedAt + audits', async () => {
    const res = await authed('put', '/api/payment-gateways/razorpay')
      .send({ keyId: 'rzp_test_x', keySecret: 'plaintext_secret', isActive: true });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    // Response is masked, never plaintext.
    expect(res.body.config.keySecret).toEqual({ configured: true, last4: '****cret' });
    // Upsert called with a rotation stamp + the secret routed through encrypt.
    const upsertArg = prisma.paymentGatewayConfig.upsert.mock.calls[0][0];
    expect(upsertArg.create.lastRotatedAt).toBeInstanceOf(Date);
    expect(upsertArg.create.keySecret).toBe('plaintext_secret'); // no-op encrypt (no field key)
    expect(prisma.auditLog.create).toHaveBeenCalled();
  });

  test('masked-sentinel echo is SKIPPED (keeps stored secret, no rotation stamp)', async () => {
    await authed('put', '/api/payment-gateways/razorpay')
      .send({ keyId: 'rzp_test_x', keySecret: '****cret', isActive: true });
    const upsertArg = prisma.paymentGatewayConfig.upsert.mock.calls[0][0];
    // keySecret must NOT appear in the update payload (sentinel skipped).
    expect(upsertArg.update.keySecret).toBeUndefined();
    expect(upsertArg.update.lastRotatedAt).toBeUndefined();
  });

  test('rejects an unsupported provider (400)', async () => {
    const res = await authed('put', '/api/payment-gateways/stripe')
      .send({ keyId: 'sk_x' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('UNSUPPORTED_PROVIDER');
    expect(prisma.paymentGatewayConfig.upsert).not.toHaveBeenCalled();
  });

  test('rejects a malformed keyId (400)', async () => {
    const res = await authed('put', '/api/payment-gateways/razorpay')
      .send({ keyId: 'not_a_razorpay_key' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_KEY_ID');
  });

  test('non-ADMIN is forbidden (403)', async () => {
    const res = await authed('put', '/api/payment-gateways/razorpay', { role: 'MANAGER' })
      .send({ keyId: 'rzp_test_x', keySecret: 's' });
    expect(res.status).toBe(403);
  });
});

describe('DELETE /api/payment-gateways/:provider', () => {
  test('removes the config + audits + scopes to tenant', async () => {
    const res = await authed('delete', '/api/payment-gateways/razorpay', { tenantId: 7 });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, deleted: 1 });
    expect(prisma.paymentGatewayConfig.deleteMany).toHaveBeenCalledWith({
      where: { tenantId: 7, provider: 'razorpay' },
    });
    expect(prisma.auditLog.create).toHaveBeenCalled();
  });

  test('idempotent — success even when nothing existed', async () => {
    prisma.paymentGatewayConfig.findFirst.mockResolvedValue(null);
    prisma.paymentGatewayConfig.deleteMany.mockResolvedValue({ count: 0 });
    const res = await authed('delete', '/api/payment-gateways/razorpay');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, deleted: 0 });
    // No audit row when there was nothing to delete.
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  test('non-ADMIN is forbidden (403)', async () => {
    const res = await authed('delete', '/api/payment-gateways/razorpay', { role: 'USER' });
    expect(res.status).toBe(403);
  });
});
