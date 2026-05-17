// @ts-check
/**
 * Unit tests for routes/pos.js — petty-cash deposit / withdraw endpoints
 * (#779 backend half). Frontend CashRegisters.jsx already wires the
 * Deposit + Withdrawal buttons; this file pins the contract that the
 * buttons POST against.
 *
 * Endpoints covered
 * ─────────────────
 *   POST   /api/pos/shifts/:id/deposit        — admin/manager, OPEN shift
 *   POST   /api/pos/shifts/:id/withdraw       — admin/manager, OPEN shift
 *   GET    /api/pos/shifts/:id/petty-cash     — cashier (own) or admin
 *
 * What this file pins
 * ───────────────────
 *   1. Happy path: deposit creates a PettyCashLedger row of type=DEPOSIT.
 *   2. Happy path: withdraw creates a PettyCashLedger row of type=WITHDRAWAL.
 *   3. Amount must be a positive number — 0 / negative / non-numeric → 400.
 *   4. Reason is required — missing / whitespace-only → 400.
 *   5. Shift must be OPEN — closed shift → 409 SHIFT_CLOSED.
 *   6. Unknown shift id → 404.
 *   7. Non-admin caller (USER role, wellnessRole=helper) → 403.
 *   8. Tenant isolation: cross-tenant shift id → 404, never 200.
 *   9. Withdraw of an amount exceeding available cash is ALLOWED (under-drawer
 *      states surface at close, not via 409). Pinned because the spec body
 *      explicitly calls this out.
 *  10. GET /:id/petty-cash returns the entries for the shift.
 *  11. Each mutation writes a Shift/CASH_LEDGER audit row.
 *
 * Pattern mirrors backend/test/routes/staff.test.js (prisma singleton
 * monkey-patch + supertest with a fake auth middleware).
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

import prisma from '../../lib/prisma.js';

prisma.shift = {
  findFirst: vi.fn(),
};
prisma.pettyCashLedger = {
  create: vi.fn(),
  findMany: vi.fn(),
};
prisma.tenant = prisma.tenant || {};
prisma.tenant.findUnique = vi.fn().mockResolvedValue({ vertical: 'wellness' });

// Avoid blowing up when audit.writeAudit logs to console for the
// audit-chain disabled path; stub auditLog model.
prisma.auditLog = prisma.auditLog || {};
prisma.auditLog.create = vi.fn().mockResolvedValue({});
prisma.auditLog.findFirst = vi.fn().mockResolvedValue(null);
// emitEvent inside route handlers calls automationRule.findMany — if unmocked
// the call hits an unconfigured Prisma client and produces an unhandled
// rejection (the route does fire-and-forget on the emit per #616). Stub with
// empty array so the dispatcher exits cleanly.
prisma.automationRule = prisma.automationRule || {};
prisma.automationRule.findMany = vi.fn().mockResolvedValue([]);

import express from 'express';
import request from 'supertest';
import { createRequire } from 'node:module';
const requireCJS = createRequire(import.meta.url);
const posRouter = requireCJS('../../routes/pos');

function makeApp({
  tenantId = 1,
  userId = 7,
  role = 'ADMIN',
  wellnessRole = 'admin',
} = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { userId, tenantId, role, wellnessRole };
    next();
  });
  app.use('/api/pos', posRouter);
  return app;
}

beforeEach(() => {
  prisma.shift.findFirst.mockReset();
  prisma.pettyCashLedger.create.mockReset();
  prisma.pettyCashLedger.findMany.mockReset();
  prisma.auditLog.create.mockReset();
  prisma.auditLog.create.mockResolvedValue({});
  prisma.tenant.findUnique.mockReset();
  prisma.tenant.findUnique.mockResolvedValue({ vertical: 'wellness' });
});

// ── POST /shifts/:id/deposit ────────────────────────────────────────

describe('POST /shifts/:id/deposit', () => {
  test('creates a DEPOSIT ledger row and audit on happy path', async () => {
    prisma.shift.findFirst.mockResolvedValue({
      id: 42,
      tenantId: 1,
      status: 'OPEN',
      userId: 7,
      registerId: 3,
      openingFloat: 500,
    });
    prisma.pettyCashLedger.create.mockResolvedValue({
      id: 101,
      shiftId: 42,
      type: 'DEPOSIT',
      amount: 2000,
      reason: 'Owner brought change',
      userId: 7,
      tenantId: 1,
      createdAt: new Date('2026-05-18'),
    });

    const res = await request(makeApp())
      .post('/api/pos/shifts/42/deposit')
      .send({ amount: 2000, reason: 'Owner brought change' });

    expect(res.status).toBe(201);
    expect(res.body.type).toBe('DEPOSIT');
    expect(res.body.amount).toBe(2000);
    expect(prisma.pettyCashLedger.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          shiftId: 42,
          type: 'DEPOSIT',
          amount: 2000,
          reason: 'Owner brought change',
          userId: 7,
          tenantId: 1,
        }),
      }),
    );
    // Audit row written
    expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
    const auditArgs = prisma.auditLog.create.mock.calls[0][0];
    expect(auditArgs.data.entity).toBe('Shift');
    expect(auditArgs.data.action).toBe('CASH_LEDGER');
  });

  test('rejects amount=0 with 400 INVALID_AMOUNT', async () => {
    prisma.shift.findFirst.mockResolvedValue({
      id: 42,
      tenantId: 1,
      status: 'OPEN',
      userId: 7,
    });
    const res = await request(makeApp())
      .post('/api/pos/shifts/42/deposit')
      .send({ amount: 0, reason: 'nope' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_AMOUNT');
    expect(prisma.pettyCashLedger.create).not.toHaveBeenCalled();
  });

  test('rejects negative amount with 400 INVALID_AMOUNT', async () => {
    prisma.shift.findFirst.mockResolvedValue({
      id: 42,
      tenantId: 1,
      status: 'OPEN',
      userId: 7,
    });
    const res = await request(makeApp())
      .post('/api/pos/shifts/42/deposit')
      .send({ amount: -100, reason: 'nope' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_AMOUNT');
  });

  test('rejects non-numeric amount with 400 INVALID_AMOUNT', async () => {
    prisma.shift.findFirst.mockResolvedValue({
      id: 42,
      tenantId: 1,
      status: 'OPEN',
      userId: 7,
    });
    const res = await request(makeApp())
      .post('/api/pos/shifts/42/deposit')
      .send({ amount: 'abc', reason: 'nope' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_AMOUNT');
  });

  test('rejects missing reason with 400 REASON_REQUIRED', async () => {
    prisma.shift.findFirst.mockResolvedValue({
      id: 42,
      tenantId: 1,
      status: 'OPEN',
      userId: 7,
    });
    const res = await request(makeApp())
      .post('/api/pos/shifts/42/deposit')
      .send({ amount: 100 });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('REASON_REQUIRED');
  });

  test('rejects whitespace-only reason with 400 REASON_REQUIRED', async () => {
    prisma.shift.findFirst.mockResolvedValue({
      id: 42,
      tenantId: 1,
      status: 'OPEN',
      userId: 7,
    });
    const res = await request(makeApp())
      .post('/api/pos/shifts/42/deposit')
      .send({ amount: 100, reason: '   ' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('REASON_REQUIRED');
  });

  test('rejects closed shift with 409 SHIFT_CLOSED', async () => {
    prisma.shift.findFirst.mockResolvedValue({
      id: 42,
      tenantId: 1,
      status: 'CLOSED',
      userId: 7,
    });
    const res = await request(makeApp())
      .post('/api/pos/shifts/42/deposit')
      .send({ amount: 100, reason: 'x' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('SHIFT_CLOSED');
  });

  test('unknown shift id returns 404', async () => {
    prisma.shift.findFirst.mockResolvedValue(null);
    const res = await request(makeApp())
      .post('/api/pos/shifts/9999/deposit')
      .send({ amount: 100, reason: 'x' });
    expect(res.status).toBe(404);
  });

  test('non-admin caller (helper) returns 403 WELLNESS_ROLE_FORBIDDEN', async () => {
    const res = await request(makeApp({ role: 'USER', wellnessRole: 'helper' }))
      .post('/api/pos/shifts/42/deposit')
      .send({ amount: 100, reason: 'x' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('WELLNESS_ROLE_FORBIDDEN');
    expect(prisma.shift.findFirst).not.toHaveBeenCalled();
  });

  test('cross-tenant shift returns 404 (tenant isolation)', async () => {
    // shift.findFirst is tenant-scoped via tenantWhere — returns null for
    // a row in another tenant even if id matches.
    prisma.shift.findFirst.mockResolvedValue(null);
    const res = await request(makeApp({ tenantId: 2 }))
      .post('/api/pos/shifts/42/deposit')
      .send({ amount: 100, reason: 'x' });
    expect(res.status).toBe(404);
    // The where clause MUST include tenantId
    const callArg = prisma.shift.findFirst.mock.calls[0][0];
    expect(callArg.where.tenantId).toBe(2);
    expect(callArg.where.id).toBe(42);
  });
});

// ── POST /shifts/:id/withdraw ────────────────────────────────────────

describe('POST /shifts/:id/withdraw', () => {
  test('creates a WITHDRAWAL ledger row on happy path', async () => {
    prisma.shift.findFirst.mockResolvedValue({
      id: 42,
      tenantId: 1,
      status: 'OPEN',
      userId: 7,
    });
    prisma.pettyCashLedger.create.mockResolvedValue({
      id: 102,
      shiftId: 42,
      type: 'WITHDRAWAL',
      amount: 250,
      reason: 'Courier fee',
      userId: 7,
      tenantId: 1,
    });

    const res = await request(makeApp())
      .post('/api/pos/shifts/42/withdraw')
      .send({ amount: 250, reason: 'Courier fee' });

    expect(res.status).toBe(201);
    expect(res.body.type).toBe('WITHDRAWAL');
    expect(prisma.pettyCashLedger.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          type: 'WITHDRAWAL',
          amount: 250,
        }),
      }),
    );
  });

  test('withdrawal exceeding available cash is allowed (under-drawer surfaces at close)', async () => {
    // Per the #779 spec body, withdrawals can exceed current cash balance
    // because the operator may need to track an IOU. Variance at close is
    // the signal, not a 409 at the time of withdraw.
    prisma.shift.findFirst.mockResolvedValue({
      id: 42,
      tenantId: 1,
      status: 'OPEN',
      userId: 7,
      openingFloat: 100,
    });
    prisma.pettyCashLedger.create.mockResolvedValue({
      id: 103,
      shiftId: 42,
      type: 'WITHDRAWAL',
      amount: 999999,
      reason: 'IOU — owner not yet reimbursed',
      userId: 7,
      tenantId: 1,
    });
    const res = await request(makeApp())
      .post('/api/pos/shifts/42/withdraw')
      .send({ amount: 999999, reason: 'IOU — owner not yet reimbursed' });
    expect(res.status).toBe(201);
  });

  test('closed shift returns 409 SHIFT_CLOSED', async () => {
    prisma.shift.findFirst.mockResolvedValue({
      id: 42,
      tenantId: 1,
      status: 'CLOSED',
      userId: 7,
    });
    const res = await request(makeApp())
      .post('/api/pos/shifts/42/withdraw')
      .send({ amount: 100, reason: 'x' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('SHIFT_CLOSED');
  });
});

// ── GET /shifts/:id/petty-cash ───────────────────────────────────────

describe('GET /shifts/:id/petty-cash', () => {
  test('admin sees all entries for the shift', async () => {
    prisma.shift.findFirst.mockResolvedValue({
      id: 42,
      tenantId: 1,
      status: 'OPEN',
      userId: 99, // a different user
    });
    prisma.pettyCashLedger.findMany.mockResolvedValue([
      { id: 1, type: 'DEPOSIT', amount: 500, shiftId: 42, reason: 'change' },
      { id: 2, type: 'WITHDRAWAL', amount: 200, shiftId: 42, reason: 'courier' },
    ]);
    const res = await request(makeApp({ userId: 7, role: 'ADMIN' }))
      .get('/api/pos/shifts/42/petty-cash');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(2);
  });

  test('non-admin cashier sees only own shift ledger', async () => {
    prisma.shift.findFirst.mockResolvedValue({
      id: 42,
      tenantId: 1,
      status: 'OPEN',
      userId: 99, // different cashier
    });
    const res = await request(makeApp({
      userId: 7,
      role: 'USER',
      wellnessRole: 'doctor',
    })).get('/api/pos/shifts/42/petty-cash');
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('SHIFT_NOT_OWNER');
  });
});
