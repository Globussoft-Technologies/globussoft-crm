// @ts-check
/**
 * Unit tests for routes/pos.js — GET /api/pos/sale-context/:patientId
 * (D17 POS New Sale, Arc 1 slice 2).
 *
 * What this file pins
 * ───────────────────
 *   HAPPY PATHS:
 *     H1. Patient with ₹1500 wallet balance → walletBalanceCents=150_000
 *         and currency taken from the Wallet row.
 *     H2. Patient with NO wallet row → walletBalanceCents=0, currency
 *         defaults to "INR".
 *     H3. Defensive Math.max(0, …) — a corrupt -₹50 row never surfaces
 *         a negative cents number to the POS form.
 *
 *   ENVELOPE SHAPE:
 *     E1. Response always includes patientId + walletBalanceCents +
 *         currency + activeMemberships (empty array stub) +
 *         pendingBookings (empty array stub). Sister fields are
 *         intentionally empty arrays (not omitted) so the frontend
 *         can render the empty state without a shape-check.
 *
 *   AUTHORISATION:
 *     T1. Cross-tenant patientId → 404 PATIENT_NOT_FOUND (never 403,
 *         so we never leak whether a row exists in another tenant).
 *     T2. role=USER + wellnessRole=null → 403 WELLNESS_ROLE_FORBIDDEN.
 *     T3. No req.user → 401 (verifyWellnessRole rejects unauthenticated).
 *
 *   VALIDATION:
 *     V1. patientId="abc" → 400 INVALID_PATIENT_ID.
 *     V2. patientId="-5" → 400 INVALID_PATIENT_ID.
 *     V3. patientId="0"  → 400 INVALID_PATIENT_ID.
 *
 * Mock surface — singleton-patch pattern matching pos-paymentMethod.test.js
 * and wallet-redeem.test.js. The route only touches prisma.patient and
 * prisma.wallet (no transaction, no audit, no event bus), so the surface
 * is minimal.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import prisma from '../../lib/prisma.js';

// ── Prisma surface required by GET /sale-context/:patientId. ──
prisma.patient = prisma.patient || {};
prisma.patient.findFirst = vi.fn();
prisma.wallet = prisma.wallet || {};
prisma.wallet.findFirst = vi.fn();
// verifyWellnessRole memoises tenant.vertical onto req.user, but on
// fresh requests (no `vertical` claim on the JWT) it falls back to
// tenant.findUnique. Stub it as wellness-default so role gating doesn't
// trip on tenant-vertical resolution.
prisma.tenant = prisma.tenant || {};
prisma.tenant.findUnique = vi.fn().mockResolvedValue({ vertical: 'wellness' });

// requirePermission middleware (backend/middleware/requirePermission.js:178)
// resolves the caller's effective roles via userRole.findMany. When the
// route declares `anyOfPermissions` (POS cashierGate does), the deny path
// for a non-allowed wellnessRole calls getUserPermissions → loadUserPermissions
// → our empty-array mock → permSet.size === 0 → maybeSelfHealAdminPermissions
// which queries prisma.user.findUnique. We stub both: userRole.findMany to []
// (no role grants) AND user.findUnique to null (self-heal exits at the
// "user not found" early return), so the middleware lands on the
// 403 WELLNESS_ROLE_FORBIDDEN path the test asserts.
prisma.userRole = prisma.userRole || {};
prisma.userRole.findMany = vi.fn();
prisma.user = prisma.user || {};
prisma.user.findUnique = vi.fn().mockResolvedValue(null);

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
  vertical = 'wellness',
  skipAuth = false,
} = {}) {
  const app = express();
  app.use(express.json());
  if (!skipAuth) {
    app.use((req, _res, next) => {
      req.user = { userId, tenantId, role, wellnessRole, vertical };
      next();
    });
  }
  app.use('/api/pos', posRouter);
  return app;
}

beforeEach(() => {
  prisma.patient.findFirst.mockReset();
  prisma.wallet.findFirst.mockReset();
  // Default pass: patient exists in tenant.
  prisma.patient.findFirst.mockResolvedValue({ id: 42 });
  prisma.wallet.findFirst.mockResolvedValue(null);
  prisma.userRole.findMany.mockReset().mockResolvedValue([]);
});

// ─── H1: Happy path — patient with ₹1500 wallet ─────────────────────────

describe('GET /api/pos/sale-context/:patientId — H1 happy path (₹1500 wallet)', () => {
  test('returns walletBalanceCents=150_000 and currency from wallet row', async () => {
    prisma.wallet.findFirst.mockResolvedValue({ balance: 1500.0, currency: 'INR' });

    const res = await request(makeApp()).get('/api/pos/sale-context/42');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      patientId: 42,
      walletBalanceCents: 150_000,
      currency: 'INR',
      activeMemberships: [],
      pendingBookings: [],
    });

    // Tenant-scope assertions on both reads.
    expect(prisma.patient.findFirst).toHaveBeenCalledWith({
      where: { tenantId: 1, id: 42 },
      select: { id: true },
    });
    expect(prisma.wallet.findFirst).toHaveBeenCalledWith({
      where: { tenantId: 1, patientId: 42 },
      select: { balance: true, currency: true },
    });
  });
});

// ─── H2: Patient with NO wallet row → 0 + INR default ──────────────────

describe('GET /api/pos/sale-context/:patientId — H2 no wallet row', () => {
  test('returns walletBalanceCents=0 and currency defaults to "INR"', async () => {
    prisma.wallet.findFirst.mockResolvedValue(null);

    const res = await request(makeApp()).get('/api/pos/sale-context/42');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      patientId: 42,
      walletBalanceCents: 0,
      currency: 'INR',
      activeMemberships: [],
      pendingBookings: [],
    });
  });
});

// ─── H3: Defensive Math.max(0, …) on corrupt negative balance ──────────

describe('GET /api/pos/sale-context/:patientId — H3 negative balance clamps to 0', () => {
  test('a -₹50 wallet row surfaces as walletBalanceCents=0 (defensive clamp)', async () => {
    prisma.wallet.findFirst.mockResolvedValue({ balance: -50.0, currency: 'INR' });

    const res = await request(makeApp()).get('/api/pos/sale-context/42');

    expect(res.status).toBe(200);
    // Wallet.balance is constrained > 0 by topup/redeem logic; this is
    // the defensive belt-and-braces clamp. The form should NEVER show
    // a negative number to the cashier (would imply "free money").
    expect(res.body.walletBalanceCents).toBe(0);
  });
});

// ─── E1: Envelope shape — sister fields are arrays, not omitted ────────

describe('GET /api/pos/sale-context/:patientId — E1 envelope shape', () => {
  test('activeMemberships and pendingBookings are always-present empty arrays', async () => {
    prisma.wallet.findFirst.mockResolvedValue({ balance: 0, currency: 'INR' });

    const res = await request(makeApp()).get('/api/pos/sale-context/42');

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.activeMemberships)).toBe(true);
    expect(res.body.activeMemberships).toEqual([]);
    expect(Array.isArray(res.body.pendingBookings)).toBe(true);
    expect(res.body.pendingBookings).toEqual([]);
    // Sister-field invariant: the frontend can destructure without a
    // hasOwnProperty check — slice 3 will populate; until then,
    // empty-arrays-not-undefined is the contract.
    expect(res.body.activeMemberships).not.toBeUndefined();
    expect(res.body.pendingBookings).not.toBeUndefined();
  });
});

// ─── T1: Cross-tenant patientId → 404 ──────────────────────────────────

describe('GET /api/pos/sale-context/:patientId — T1 cross-tenant 404', () => {
  test('patient in tenant B → ADMIN of tenant A gets 404 (not 403)', async () => {
    prisma.patient.findFirst.mockResolvedValue(null);

    const res = await request(makeApp({ tenantId: 1 })).get('/api/pos/sale-context/777');

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: 'PATIENT_NOT_FOUND' });
    // Wallet read MUST NOT have fired — short-circuit on patient miss
    // (no signal-leakage of cross-tenant wallet shape).
    expect(prisma.wallet.findFirst).not.toHaveBeenCalled();
  });
});

// ─── T2: USER without clinical/operational role → 403 ─────────────────

describe('GET /api/pos/sale-context/:patientId — T2 USER without role → 403', () => {
  test('role=USER + wellnessRole=null → 403 WELLNESS_ROLE_FORBIDDEN', async () => {
    const res = await request(
      makeApp({ role: 'USER', wellnessRole: null }),
    ).get('/api/pos/sale-context/42');

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'WELLNESS_ROLE_FORBIDDEN' });
    // Gate denial fires BEFORE any prisma access — no patient lookup,
    // no wallet lookup.
    expect(prisma.patient.findFirst).not.toHaveBeenCalled();
    expect(prisma.wallet.findFirst).not.toHaveBeenCalled();
  });

  test('wellnessRole=doctor passes the gate (positive control)', async () => {
    prisma.wallet.findFirst.mockResolvedValue({ balance: 200.0, currency: 'INR' });

    const res = await request(
      makeApp({ role: 'USER', wellnessRole: 'doctor' }),
    ).get('/api/pos/sale-context/42');

    expect(res.status).toBe(200);
    expect(res.body.walletBalanceCents).toBe(20_000);
  });
});

// ─── T3: Unauthenticated → 401 ─────────────────────────────────────────

describe('GET /api/pos/sale-context/:patientId — T3 no req.user → 401', () => {
  test('request with no req.user → 401 Authentication required', async () => {
    const res = await request(makeApp({ skipAuth: true })).get('/api/pos/sale-context/42');

    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ error: 'Authentication required' });
    expect(prisma.patient.findFirst).not.toHaveBeenCalled();
  });
});

// ─── V1/V2/V3: patientId param validation ──────────────────────────────

describe('GET /api/pos/sale-context/:patientId — V1/V2/V3 patientId validation', () => {
  test('V1 patientId="abc" → 400 INVALID_PATIENT_ID', async () => {
    const res = await request(makeApp()).get('/api/pos/sale-context/abc');

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_PATIENT_ID' });
    expect(prisma.patient.findFirst).not.toHaveBeenCalled();
  });

  test('V2 patientId="-5" → 400 INVALID_PATIENT_ID', async () => {
    const res = await request(makeApp()).get('/api/pos/sale-context/-5');

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_PATIENT_ID' });
    expect(prisma.patient.findFirst).not.toHaveBeenCalled();
  });

  test('V3 patientId="0" → 400 INVALID_PATIENT_ID', async () => {
    const res = await request(makeApp()).get('/api/pos/sale-context/0');

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_PATIENT_ID' });
    expect(prisma.patient.findFirst).not.toHaveBeenCalled();
  });
});
