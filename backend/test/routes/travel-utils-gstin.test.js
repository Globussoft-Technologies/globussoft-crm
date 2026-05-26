// @ts-check
/**
 * #902 slice 14 — GET /api/travel/utils/validate-gstin operator endpoint.
 *
 * Wraps the slice-13 `backend/lib/gstinValidator.js` pure validator in a
 * read-only HTTP surface so the supplier / contact / vendor forms can
 * pre-validate a GSTIN before submit.  Operator-facing (ADMIN+MANAGER);
 * no write side effects, no schema touches.
 *
 * What this pins
 * --------------
 *   - Happy path:     valid GSTIN → 200 { valid:true, stateName, stateCode,
 *                     errors:[] }.
 *   - Auth gate:      no token → 401.
 *   - RBAC gate:      USER role → 403 RBAC_DENIED.
 *   - Vertical gate:  non-travel tenant → 403 WRONG_VERTICAL.
 *   - Missing param:  no `gstin` query → 400 MISSING_GSTIN.
 *   - Empty param:    `gstin=` → 400 MISSING_GSTIN.
 *   - Format-bad:     gibberish → 200 { valid:false, errors:[INVALID_FORMAT] }.
 *   - State-bad:      state code 40 (not on CBIC list) → 200 { valid:false,
 *                     errors:[INVALID_STATE_CODE] }.
 *   - Checksum-bad:   right format + right state + flipped last char → 200
 *                     { valid:false, errors:[INVALID_CHECKSUM], stateName,
 *                     stateCode } (state info IS trustworthy because the
 *                     state code passed).
 *   - Lowercase:      lowercase input → echoed back uppercase + valid=true.
 *   - State decode:   confirms stateName matches the CBIC table (27 →
 *                     Maharashtra).
 *
 * Pattern: patch the prisma singleton's `tenant.findUnique` + auth-related
 * lookups BEFORE requiring the router, then drive supertest with real
 * HS256 JWTs signed with the same fallback secret the middleware uses
 * in dev (mirrors travel-suppliers-search.test.js).  eventBus is implicitly
 * NOT imported by the route — no mock needed.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import prisma from '../../lib/prisma.js';

prisma.tenant = prisma.tenant || {};
prisma.tenant.findUnique = vi.fn().mockResolvedValue({
  id: 1,
  vertical: 'travel',
  name: 'Test Travel',
  slug: 'test-travel',
});
prisma.user = prisma.user || {};
prisma.user.findUnique = vi.fn().mockResolvedValue({ role: 'ADMIN', subBrandAccess: null });
prisma.revokedToken = prisma.revokedToken || {};
prisma.revokedToken.findUnique = vi.fn().mockResolvedValue(null);

// eventBus mock — defensive even though /utils/validate-gstin doesn't emit;
// this matches the standing test pattern so a future route addition in
// travel.js that DOES emit won't break this spec.
vi.mock('../../lib/eventBus', () => ({
  default: { emit: vi.fn(), on: vi.fn(), off: vi.fn() },
  emit: vi.fn(),
  on: vi.fn(),
  off: vi.fn(),
}));

import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createRequire } from 'node:module';

const requireCJS = createRequire(import.meta.url);
const JWT_SECRET = process.env.JWT_SECRET || 'enterprise_super_secret_key_2026';
const travelRouter = requireCJS('../../routes/travel');
const gstinValidator = requireCJS('../../lib/gstinValidator');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/travel', travelRouter);
  return app;
}

function tokenFor(role = 'ADMIN', { userId = 7, tenantId = 1 } = {}) {
  return jwt.sign(
    { userId, tenantId, role, email: `${role.toLowerCase()}@test.local` },
    JWT_SECRET,
    { expiresIn: '1h' },
  );
}

// Build a valid GSTIN deterministically from the lib so the test isn't
// brittle if a fixture rotates.  '27' → Maharashtra.
const VALID_PREFIX_14 = '27AAACR4849R1Z';
const VALID_CHECKSUM = gstinValidator.computeChecksumChar(VALID_PREFIX_14);
const VALID_GSTIN = VALID_PREFIX_14 + VALID_CHECKSUM;
const BAD_CHECKSUM_CHAR = VALID_CHECKSUM === 'A' ? 'B' : 'A';
const BAD_CHECKSUM_GSTIN = VALID_PREFIX_14 + BAD_CHECKSUM_CHAR;

beforeEach(() => {
  prisma.tenant.findUnique.mockReset().mockResolvedValue({
    id: 1, vertical: 'travel', name: 'Test Travel', slug: 'test-travel',
  });
  prisma.user.findUnique.mockReset().mockResolvedValue({ role: 'ADMIN', subBrandAccess: null });
  prisma.revokedToken.findUnique.mockReset().mockResolvedValue(null);
});

describe('GET /api/travel/utils/validate-gstin', () => {
  test('happy path: valid GSTIN returns 200 { valid:true, stateName, stateCode, errors:[] }', async () => {
    const res = await request(makeApp())
      .get(`/api/travel/utils/validate-gstin?gstin=${VALID_GSTIN}`)
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      gstin: VALID_GSTIN,
      valid: true,
      stateName: 'Maharashtra',
      stateCode: '27',
      errors: [],
    });
  });

  test('happy path: MANAGER role is accepted (operator-facing low-cost lookup)', async () => {
    const res = await request(makeApp())
      .get(`/api/travel/utils/validate-gstin?gstin=${VALID_GSTIN}`)
      .set('Authorization', `Bearer ${tokenFor('MANAGER')}`);
    expect(res.status).toBe(200);
    expect(res.body.valid).toBe(true);
  });

  test('auth gate: no Authorization header → 401', async () => {
    const res = await request(makeApp())
      .get(`/api/travel/utils/validate-gstin?gstin=${VALID_GSTIN}`);
    expect(res.status).toBe(401);
  });

  test('RBAC gate: USER role → 403 RBAC_DENIED', async () => {
    const res = await request(makeApp())
      .get(`/api/travel/utils/validate-gstin?gstin=${VALID_GSTIN}`)
      .set('Authorization', `Bearer ${tokenFor('USER')}`);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('RBAC_DENIED');
  });

  test('vertical gate: wellness tenant → 403 WRONG_VERTICAL', async () => {
    prisma.tenant.findUnique.mockResolvedValueOnce({
      id: 1, vertical: 'wellness', name: 'Wellness', slug: 'wellness',
    });
    const res = await request(makeApp())
      .get(`/api/travel/utils/validate-gstin?gstin=${VALID_GSTIN}`)
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('WRONG_VERTICAL');
  });

  test('validation: missing gstin query → 400 MISSING_GSTIN', async () => {
    const res = await request(makeApp())
      .get('/api/travel/utils/validate-gstin')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('MISSING_GSTIN');
  });

  test('validation: empty gstin query → 400 MISSING_GSTIN', async () => {
    const res = await request(makeApp())
      .get('/api/travel/utils/validate-gstin?gstin=')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('MISSING_GSTIN');
  });

  test('validation: whitespace-only gstin → 400 MISSING_GSTIN', async () => {
    const res = await request(makeApp())
      .get('/api/travel/utils/validate-gstin?gstin=%20%20%20')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('MISSING_GSTIN');
  });

  test('format-invalid: gibberish → 200 { valid:false, errors:[INVALID_FORMAT] } with null state info', async () => {
    const res = await request(makeApp())
      .get('/api/travel/utils/validate-gstin?gstin=NOPE')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    expect(res.body.valid).toBe(false);
    expect(res.body.errors).toEqual(['INVALID_FORMAT']);
    expect(res.body.stateName).toBe(null);
    expect(res.body.stateCode).toBe(null);
    expect(res.body.gstin).toBe('NOPE');
  });

  test('format-invalid: 15-char wrong-shape (digits where letters expected) → INVALID_FORMAT', async () => {
    // 15 chars but positions 3-7 must be letters; "12345" breaks the
    // alphabetic-prefix invariant.
    const res = await request(makeApp())
      .get('/api/travel/utils/validate-gstin?gstin=2712345678AR1ZZ')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    expect(res.body.valid).toBe(false);
    expect(res.body.errors).toEqual(['INVALID_FORMAT']);
  });

  test('state-invalid: state code 40 (not on CBIC list) → INVALID_STATE_CODE; stateCode echoed, stateName null', async () => {
    // Build a structurally-valid 15-char string with state code 40.
    const badStateGstin = '40' + VALID_PREFIX_14.slice(2) + 'Z';
    const res = await request(makeApp())
      .get(`/api/travel/utils/validate-gstin?gstin=${badStateGstin}`)
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    expect(res.body.valid).toBe(false);
    expect(res.body.errors).toEqual(['INVALID_STATE_CODE']);
    expect(res.body.stateCode).toBe('40');
    expect(res.body.stateName).toBe(null);
  });

  test('checksum-invalid: right format + state + flipped last char → INVALID_CHECKSUM with full state info', async () => {
    const res = await request(makeApp())
      .get(`/api/travel/utils/validate-gstin?gstin=${BAD_CHECKSUM_GSTIN}`)
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    expect(res.body.valid).toBe(false);
    expect(res.body.errors).toEqual(['INVALID_CHECKSUM']);
    // Checksum-invalid still trusts state info — state code passed.
    expect(res.body.stateCode).toBe('27');
    expect(res.body.stateName).toBe('Maharashtra');
  });

  test('normalisation: lowercase input → echoed back uppercase, valid:true', async () => {
    const res = await request(makeApp())
      .get(`/api/travel/utils/validate-gstin?gstin=${VALID_GSTIN.toLowerCase()}`)
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    expect(res.body.gstin).toBe(VALID_GSTIN);
    expect(res.body.valid).toBe(true);
  });

  test('normalisation: leading/trailing whitespace → trimmed + uppercased', async () => {
    const padded = `  ${VALID_GSTIN.toLowerCase()}  `;
    const res = await request(makeApp())
      .get(`/api/travel/utils/validate-gstin?gstin=${encodeURIComponent(padded)}`)
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    expect(res.body.gstin).toBe(VALID_GSTIN);
    expect(res.body.valid).toBe(true);
  });

  test('state-name decode: state 07 → Delhi (CBIC table sanity check)', async () => {
    // Build a checksum-valid GSTIN with state code 07.
    const prefix14 = '07AAACR4849R1Z';
    const checksum = gstinValidator.computeChecksumChar(prefix14);
    const delhiGstin = prefix14 + checksum;
    const res = await request(makeApp())
      .get(`/api/travel/utils/validate-gstin?gstin=${delhiGstin}`)
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    expect(res.body.valid).toBe(true);
    expect(res.body.stateCode).toBe('07');
    expect(res.body.stateName).toBe('Delhi');
  });
});
