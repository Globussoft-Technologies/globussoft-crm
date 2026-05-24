// @ts-check
/**
 * Unit tests for backend/routes/wallet.js — D16 Wallet Top-up slice
 * 2-partial (read routes only).
 *
 * What this file pins
 * ───────────────────
 *   1. GET /:patientId/balance returns 200 + {balanceCents, currency,
 *      lastUpdated} for an ADMIN on a wellness tenant with an existing
 *      Wallet row (balance Float rupees → integer cents at the wire).
 *   2. Patient with no Wallet row returns balanceCents:0 + currency:'INR'
 *      + lastUpdated:null (no auto-create on read — slice 3 owns
 *      first-write).
 *   3. Cross-tenant 404 — ADMIN of tenant A cannot read a patient row
 *      that lives in tenant B. tenantWhere scopes the lookup; missing
 *      patient → 404, not 403, so we never reveal cross-tenant
 *      existence.
 *   4. Unauthenticated → 401 (phiReadGate's `if (!req.user)` branch).
 *   5. role=USER with no wellnessRole → 403 WELLNESS_ROLE_FORBIDDEN.
 *      Pins the phiReadGate denial — low-trust viewers cannot read
 *      financial PHI even on a wellness tenant.
 *   6. GET /:patientId/transactions returns 200 + {transactions, total}
 *      envelope with pagination respected (limit/offset wire through to
 *      Prisma's take/skip).
 *   7. Patient with no Wallet row returns {transactions:[], total:0}
 *      (not 404 — wallet emptiness ≠ patient missing).
 *   8. Limit clamping — capLimit defaults to 25 and clamps to max 100.
 *   9. WALLET_BALANCE_READ audit row fires on every successful balance
 *      read (fire-and-forget per #534 PERF-1).
 *
 * Test pattern mirrors backend/test/routes/wellness-patients-xlsx.test.js
 * — patch the prisma singleton BEFORE requiring the router, mount under
 * a tiny Express app, inject req.user via a synthetic middleware (the
 * production global verifyToken would normally populate it).
 *
 * Why mocked prisma (not the live MySQL container): keeps the per-push
 * unit-test gate fast + isolated. The e2e api-spec layer will exercise
 * the full DB round-trip in a future tick once Agent A's schema lands.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import prisma from '../../lib/prisma.js';

// ── Prisma surface required by routes/wallet.js at require-time + the
//    middleware/wellnessRole resolver. Defensive permissive stubs for
//    every delegate either side might touch.
prisma.patient = prisma.patient || {};
prisma.patient.findFirst = vi.fn();

prisma.wallet = prisma.wallet || {};
prisma.wallet.findFirst = vi.fn();

prisma.walletTransaction = prisma.walletTransaction || {};
prisma.walletTransaction.findMany = vi.fn();
prisma.walletTransaction.count = vi.fn();

// auditLog.create is what writeAudit ultimately calls. Force-replace so
// the real client's delegate (if any) doesn't leak across tests.
prisma.auditLog = { create: vi.fn().mockResolvedValue({ id: 1 }) };

// tenant.findUnique is hit by resolveTenantVertical when the JWT lacks a
// memoised `vertical` claim. We seed it with a wellness tenant by
// default so phiReadGate doesn't trip WELLNESS_TENANT_REQUIRED.
prisma.tenant = prisma.tenant || {};
prisma.tenant.findUnique = vi.fn().mockResolvedValue({ vertical: 'wellness' });

import express from 'express';
import request from 'supertest';
import { createRequire } from 'node:module';
const requireCJS = createRequire(import.meta.url);
const walletRouter = requireCJS('../../routes/wallet');

/**
 * Mount the wallet router with an optional synthetic auth middleware.
 * - `noAuth: true` → no req.user injection, so phiReadGate returns 401.
 * - `vertical` defaults to "wellness" so phiReadGate doesn't trip the
 *   WELLNESS_TENANT_REQUIRED gate.
 */
function makeApp({
  tenantId = 1,
  userId = 7,
  role = 'ADMIN',
  wellnessRole = null,
  vertical = 'wellness',
  noAuth = false,
} = {}) {
  const app = express();
  app.use(express.json());
  if (!noAuth) {
    app.use((req, _res, next) => {
      req.user = { userId, tenantId, role, wellnessRole, vertical };
      next();
    });
  }
  app.use('/api/wallet', walletRouter);
  return app;
}

beforeEach(() => {
  prisma.patient.findFirst.mockReset();
  prisma.wallet.findFirst.mockReset();
  prisma.walletTransaction.findMany.mockReset();
  prisma.walletTransaction.count.mockReset();
  prisma.auditLog.create.mockReset();
  prisma.auditLog.create.mockResolvedValue({ id: 1 });
});

describe('GET /api/wallet/:patientId/balance — (1) existing wallet', () => {
  test('returns 200 + balanceCents:Math.round(balance*100) + currency + lastUpdated', async () => {
    prisma.patient.findFirst.mockResolvedValue({ id: 42 });
    prisma.wallet.findFirst.mockResolvedValue({
      balance: 123.45,
      currency: 'INR',
      updatedAt: new Date('2026-05-25T10:00:00Z'),
    });
    const res = await request(makeApp()).get('/api/wallet/42/balance');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      balanceCents: 12345,
      currency: 'INR',
      lastUpdated: '2026-05-25T10:00:00.000Z',
    });
    // Patient lookup scoped to caller's tenant.
    expect(prisma.patient.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ tenantId: 1, id: 42 }),
      }),
    );
    // Wallet lookup scoped to caller's tenant + patientId.
    expect(prisma.wallet.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ tenantId: 1, patientId: 42 }),
      }),
    );
  });
});

describe('GET /api/wallet/:patientId/balance — (2) no wallet row', () => {
  test('returns 200 + balanceCents:0 + currency:"INR" + lastUpdated:null (no auto-create)', async () => {
    prisma.patient.findFirst.mockResolvedValue({ id: 99 });
    prisma.wallet.findFirst.mockResolvedValue(null);
    const res = await request(makeApp()).get('/api/wallet/99/balance');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      balanceCents: 0,
      currency: 'INR',
      lastUpdated: null,
    });
  });
});

describe('GET /api/wallet/:patientId/balance — (3) cross-tenant 404', () => {
  test('ADMIN of tenant 1 cannot read patient that lives in tenant 2 → 404 (not 403)', async () => {
    // Patient lookup with tenantId:1 + id:777 → no row (because the
    // real patient 777 lives in tenant 2; findFirst's tenant-scoped
    // where simulates this by returning null).
    prisma.patient.findFirst.mockResolvedValue(null);
    const res = await request(makeApp({ tenantId: 1 })).get('/api/wallet/777/balance');
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ error: 'Patient not found' });
    // Wallet lookup MUST NOT have run — the patient-existence guard
    // fires first to avoid leaking tenant-B wallet rows.
    expect(prisma.wallet.findFirst).not.toHaveBeenCalled();
  });
});

describe('GET /api/wallet/:patientId/balance — (4) unauthenticated → 401', () => {
  test('no req.user → phiReadGate emits 401 Authentication required', async () => {
    const res = await request(makeApp({ noAuth: true })).get('/api/wallet/42/balance');
    expect(res.status).toBe(401);
    // patient/wallet lookups never run — gate fires before the handler.
    expect(prisma.patient.findFirst).not.toHaveBeenCalled();
    expect(prisma.wallet.findFirst).not.toHaveBeenCalled();
  });
});

describe('GET /api/wallet/:patientId/balance — (5) USER without PHI access → 403', () => {
  test('role=USER + no wellnessRole → 403 WELLNESS_ROLE_FORBIDDEN', async () => {
    const res = await request(
      makeApp({ role: 'USER', wellnessRole: null }),
    ).get('/api/wallet/42/balance');
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'WELLNESS_ROLE_FORBIDDEN' });
    // Handler body never reached.
    expect(prisma.patient.findFirst).not.toHaveBeenCalled();
  });
});

describe('GET /api/wallet/:patientId/transactions — (6) pagination envelope', () => {
  test('returns 200 + {transactions, total} with limit/offset wired into take/skip', async () => {
    prisma.patient.findFirst.mockResolvedValue({ id: 42 });
    prisma.wallet.findFirst.mockResolvedValue({ id: 7 });
    const txnRows = [
      { id: 5, walletId: 7, type: 'CREDIT', amount: 100, balanceAfter: 500, createdAt: new Date() },
      { id: 4, walletId: 7, type: 'DEBIT', amount: -50, balanceAfter: 400, createdAt: new Date() },
    ];
    prisma.walletTransaction.findMany.mockResolvedValue(txnRows);
    prisma.walletTransaction.count.mockResolvedValue(17);

    const res = await request(makeApp()).get(
      '/api/wallet/42/transactions?limit=10&offset=20',
    );
    expect(res.status).toBe(200);
    expect(res.body.transactions).toHaveLength(2);
    expect(res.body.total).toBe(17);

    // take/skip wired through correctly.
    expect(prisma.walletTransaction.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ tenantId: 1, walletId: 7 }),
        take: 10,
        skip: 20,
        orderBy: { createdAt: 'desc' },
      }),
    );
  });
});

describe('GET /api/wallet/:patientId/transactions — (7) empty patient', () => {
  test('patient exists but no Wallet row → {transactions:[], total:0} (NOT 404)', async () => {
    prisma.patient.findFirst.mockResolvedValue({ id: 99 });
    prisma.wallet.findFirst.mockResolvedValue(null);

    const res = await request(makeApp()).get('/api/wallet/99/transactions');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ transactions: [], total: 0 });
    // WalletTransaction.findMany MUST NOT have run with walletId:undefined
    // (which Prisma would treat as "any" and leak cross-patient rows).
    expect(prisma.walletTransaction.findMany).not.toHaveBeenCalled();
    expect(prisma.walletTransaction.count).not.toHaveBeenCalled();
  });

  test('patient missing in tenant → 404 (NOT empty envelope)', async () => {
    prisma.patient.findFirst.mockResolvedValue(null);
    const res = await request(makeApp()).get('/api/wallet/777/transactions');
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ error: 'Patient not found' });
  });
});

describe('GET /api/wallet/:patientId/transactions — (8) limit clamping', () => {
  test('default limit=25 when query param absent', async () => {
    prisma.patient.findFirst.mockResolvedValue({ id: 42 });
    prisma.wallet.findFirst.mockResolvedValue({ id: 7 });
    prisma.walletTransaction.findMany.mockResolvedValue([]);
    prisma.walletTransaction.count.mockResolvedValue(0);

    const res = await request(makeApp()).get('/api/wallet/42/transactions');
    expect(res.status).toBe(200);
    expect(prisma.walletTransaction.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 25, skip: 0 }),
    );
  });

  test('limit=999 clamps to max 100', async () => {
    prisma.patient.findFirst.mockResolvedValue({ id: 42 });
    prisma.wallet.findFirst.mockResolvedValue({ id: 7 });
    prisma.walletTransaction.findMany.mockResolvedValue([]);
    prisma.walletTransaction.count.mockResolvedValue(0);

    const res = await request(makeApp()).get('/api/wallet/42/transactions?limit=999');
    expect(res.status).toBe(200);
    expect(prisma.walletTransaction.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 100 }),
    );
  });
});

describe('GET /api/wallet/:patientId/balance — (9) audit emission', () => {
  test('successful read fires WALLET_BALANCE_READ audit row (fire-and-forget)', async () => {
    prisma.patient.findFirst.mockResolvedValue({ id: 42 });
    prisma.wallet.findFirst.mockResolvedValue({
      balance: 50,
      currency: 'INR',
      updatedAt: new Date('2026-05-25T10:00:00Z'),
    });
    const res = await request(makeApp()).get('/api/wallet/42/balance');
    expect(res.status).toBe(200);

    // writeAudit is fire-and-forget — let the microtask queue flush.
    await new Promise((r) => setImmediate(r));

    const calls = prisma.auditLog.create.mock.calls.map((c) => c[0].data || c[0]);
    const auditRow = calls.find((d) => d.action === 'WALLET_BALANCE_READ');
    expect(auditRow).toBeDefined();
    expect(auditRow.entity).toBe('Patient');
    expect(auditRow.entityId).toBe(42);
    expect(auditRow.userId).toBe(7);
    expect(auditRow.tenantId).toBe(1);
  });
});
