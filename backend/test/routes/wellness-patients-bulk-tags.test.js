// @ts-check
/**
 * Unit tests for #931 (tick #196) — PATCH /api/wellness/patients/bulk-tags
 * EXTENDED with the additive `removeTags` array.
 *
 * What this file pins
 * ───────────────────
 *   Add-tag (existing contract, pinned here for completeness):
 *     A1. addTags-only call merges + dedups + JSON-stringifies + writes.
 *     A2. addTags-only call dedups case-insensitively (NEW + new → 'new').
 *
 *   Remove-tag (tick #196 additive surface):
 *     R1. removeTags-only call drops the listed tags from every patientId
 *         that actually has one of them set.
 *     R2. Combined call (addTags + removeTags) applies BOTH — addTags first
 *         (union), then removeTags (set-diff). Explicit-remove wins when a
 *         tag appears in both lists.
 *     R3. removeTags entry that doesn't exist on the patient is a no-op
 *         (no DB write, no error).
 *
 *   Validation:
 *     V1. Neither addTags nor removeTags present → 400 EMPTY_TAG_LIST.
 *     V2. Both present but both empty arrays → 400 EMPTY_TAG_LIST.
 *     V3. removeTags array > 20 entries → 400 BULK_LIMIT_EXCEEDED.
 *     V4. Idempotent skip: patient with NO tags + removeTags=['X'] → zero
 *         prisma.patient.update calls (no DB churn).
 *
 *   Response envelope:
 *     E1. Response includes both `updated` and `removed` count fields
 *         (additive to the prior `{ updated }` shape).
 *
 * Why mocked prisma (not the live MySQL container): keeps the unit-test
 * gate fast + isolated. The mutation surface IS the contract — we assert
 * what `prisma.patient.update` was called with for each scenario. The
 * e2e-full / api_tests suite exercises round-trip persistence against real
 * MySQL via wellness-*-api.spec.js partners.
 *
 * Test pattern mirrors backend/test/routes/wellness-patients-filters.test.js
 * — patch the prisma singleton BEFORE requiring the router so the router
 * binds to the spy'd functions, mount under a tiny Express app, inject
 * `req.user` via a synthetic middleware (role=ADMIN passes phiWriteGate
 * via the verifyWellnessRole "admin" special token).
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import prisma from '../../lib/prisma.js';

// ── Prisma surface required by routes/wellness.js at require-time. ──
prisma.patient = prisma.patient || {};
prisma.patient.findMany = vi.fn();
prisma.patient.update = vi.fn();
prisma.patient.count = prisma.patient.count || vi.fn();
prisma.patient.findFirst = prisma.patient.findFirst || vi.fn();

// auditLog.create is what writeAudit ultimately calls.
prisma.auditLog = { create: vi.fn().mockResolvedValue({ id: 1 }) };

// Other delegates touched at module-eval time inside routes/wellness.js
// (defensive permissive stubs):
prisma.loyaltyConfig = prisma.loyaltyConfig || { findUnique: vi.fn(), upsert: vi.fn() };
prisma.loyaltyTransaction = prisma.loyaltyTransaction || {
  findFirst: vi.fn(), aggregate: vi.fn(), findMany: vi.fn(), create: vi.fn(),
};
prisma.referral = prisma.referral || { findMany: vi.fn(), count: vi.fn() };

import express from 'express';
import request from 'supertest';
import { createRequire } from 'node:module';
const requireCJS = createRequire(import.meta.url);
const wellnessRouter = requireCJS('../../routes/wellness');

function makeApp({
  tenantId = 1,
  userId = 7,
  role = 'ADMIN',
  wellnessRole = null,
  vertical = 'wellness',
} = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { userId, tenantId, role, wellnessRole, vertical };
    next();
  });
  app.use('/api/wellness', wellnessRouter);
  return app;
}

function makePatientRow(id, tags) {
  // `tags` is the raw String? column value (null or JSON-stringified array).
  return { id, tags };
}

beforeEach(() => {
  prisma.patient.findMany.mockReset();
  prisma.patient.update.mockReset();
  prisma.patient.findMany.mockResolvedValue([]);
  prisma.patient.update.mockResolvedValue({ id: 1 });
  prisma.auditLog.create.mockReset();
  prisma.auditLog.create.mockResolvedValue({ id: 1 });
});

// ─── Add-tag baseline (existing contract) ──────────────────────────────

describe('PATCH /api/wellness/patients/bulk-tags — A1 addTags-only', () => {
  test('merges + dedups + stringifies + writes one row', async () => {
    prisma.patient.findMany.mockResolvedValue([
      makePatientRow(1, JSON.stringify(['existing'])),
    ]);
    const res = await request(makeApp())
      .patch('/api/wellness/patients/bulk-tags')
      .send({ patientIds: [1], addTags: ['vip', 'follow-up'] });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ updated: 1, removed: 0 });
    expect(prisma.patient.update).toHaveBeenCalledTimes(1);
    const writtenTags = JSON.parse(prisma.patient.update.mock.calls[0][0].data.tags);
    expect(writtenTags).toEqual(['existing', 'vip', 'follow-up']);
  });
});

describe('PATCH /api/wellness/patients/bulk-tags — A2 case-insensitive dedup', () => {
  test('NEW + new + existing → single canonical lowercase form', async () => {
    prisma.patient.findMany.mockResolvedValue([
      makePatientRow(1, JSON.stringify(['VIP'])),
    ]);
    const res = await request(makeApp())
      .patch('/api/wellness/patients/bulk-tags')
      .send({ patientIds: [1], addTags: ['NEW', 'new', 'newish'] });
    expect(res.status).toBe(200);
    const writtenTags = JSON.parse(prisma.patient.update.mock.calls[0][0].data.tags);
    expect(writtenTags).toEqual(['vip', 'new', 'newish']);
  });
});

// ─── Remove-tag (tick #196 additive surface) ───────────────────────────

describe('PATCH /api/wellness/patients/bulk-tags — R1 removeTags-only', () => {
  test('drops the listed tags from each patient that has them', async () => {
    prisma.patient.findMany.mockResolvedValue([
      makePatientRow(1, JSON.stringify(['vip', 'junk', 'follow-up'])),
      makePatientRow(2, JSON.stringify(['junk', 'cold'])),
    ]);
    const res = await request(makeApp())
      .patch('/api/wellness/patients/bulk-tags')
      .send({ patientIds: [1, 2], removeTags: ['junk'] });
    expect(res.status).toBe(200);
    expect(res.body.updated).toBe(2);
    expect(res.body.removed).toBe(2);
    expect(prisma.patient.update).toHaveBeenCalledTimes(2);
    const row1Tags = JSON.parse(prisma.patient.update.mock.calls[0][0].data.tags);
    const row2Tags = JSON.parse(prisma.patient.update.mock.calls[1][0].data.tags);
    expect(row1Tags).toEqual(['vip', 'follow-up']);
    expect(row2Tags).toEqual(['cold']);
  });

  test('case-insensitive — removeTags=["JUNK"] removes stored "junk"', async () => {
    prisma.patient.findMany.mockResolvedValue([
      makePatientRow(1, JSON.stringify(['junk', 'vip'])),
    ]);
    const res = await request(makeApp())
      .patch('/api/wellness/patients/bulk-tags')
      .send({ patientIds: [1], removeTags: ['JUNK'] });
    expect(res.status).toBe(200);
    const writtenTags = JSON.parse(prisma.patient.update.mock.calls[0][0].data.tags);
    expect(writtenTags).toEqual(['vip']);
  });
});

describe('PATCH /api/wellness/patients/bulk-tags — R2 combined add + remove', () => {
  test('applies addTags first (union), then removeTags (set-diff)', async () => {
    prisma.patient.findMany.mockResolvedValue([
      makePatientRow(1, JSON.stringify(['old-tag', 'stale'])),
    ]);
    const res = await request(makeApp())
      .patch('/api/wellness/patients/bulk-tags')
      .send({
        patientIds: [1],
        addTags: ['vip', 'urgent'],
        removeTags: ['stale'],
      });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ updated: 1, removed: 1 });
    const writtenTags = JSON.parse(prisma.patient.update.mock.calls[0][0].data.tags);
    expect(writtenTags).toEqual(['old-tag', 'vip', 'urgent']);
  });

  test('tag in BOTH addTags and removeTags → explicit-remove wins', async () => {
    prisma.patient.findMany.mockResolvedValue([
      makePatientRow(1, JSON.stringify(['existing'])),
    ]);
    const res = await request(makeApp())
      .patch('/api/wellness/patients/bulk-tags')
      .send({
        patientIds: [1],
        addTags: ['conflict', 'keep'],
        removeTags: ['conflict'],
      });
    expect(res.status).toBe(200);
    const writtenTags = JSON.parse(prisma.patient.update.mock.calls[0][0].data.tags);
    expect(writtenTags).toEqual(['existing', 'keep']);
    // The patient didn't pre-have 'conflict', so `removed` counts ZERO
    // (it measures operator-perceived removal vs the existing baseline).
    expect(res.body.removed).toBe(0);
  });
});

describe('PATCH /api/wellness/patients/bulk-tags — R3 remove non-existent tag is no-op', () => {
  test('removeTags=["never-set"] against patient without it → zero update calls', async () => {
    prisma.patient.findMany.mockResolvedValue([
      makePatientRow(1, JSON.stringify(['vip', 'follow-up'])),
    ]);
    const res = await request(makeApp())
      .patch('/api/wellness/patients/bulk-tags')
      .send({ patientIds: [1], removeTags: ['never-set'] });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ updated: 0, removed: 0 });
    // Idempotent — no DB write because the effective tag-set didn't change.
    expect(prisma.patient.update).not.toHaveBeenCalled();
  });
});

// ─── Validation (V1-V3) ────────────────────────────────────────────────

describe('PATCH /api/wellness/patients/bulk-tags — V1 neither addTags nor removeTags', () => {
  test('omitting both → 400 EMPTY_TAG_LIST', async () => {
    const res = await request(makeApp())
      .patch('/api/wellness/patients/bulk-tags')
      .send({ patientIds: [1] });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('EMPTY_TAG_LIST');
    expect(prisma.patient.findMany).not.toHaveBeenCalled();
    expect(prisma.patient.update).not.toHaveBeenCalled();
  });
});

describe('PATCH /api/wellness/patients/bulk-tags — V2 both empty arrays', () => {
  test('addTags=[] + removeTags=[] → 400 EMPTY_TAG_LIST', async () => {
    const res = await request(makeApp())
      .patch('/api/wellness/patients/bulk-tags')
      .send({ patientIds: [1], addTags: [], removeTags: [] });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('EMPTY_TAG_LIST');
    expect(prisma.patient.update).not.toHaveBeenCalled();
  });
});

describe('PATCH /api/wellness/patients/bulk-tags — V3 removeTags > 20 entries', () => {
  test('removeTags with 21 entries → 400 BULK_LIMIT_EXCEEDED', async () => {
    const tooMany = Array.from({ length: 21 }, (_, i) => `tag-${i}`);
    const res = await request(makeApp())
      .patch('/api/wellness/patients/bulk-tags')
      .send({ patientIds: [1], removeTags: tooMany });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('BULK_LIMIT_EXCEEDED');
    expect(prisma.patient.findMany).not.toHaveBeenCalled();
    expect(prisma.patient.update).not.toHaveBeenCalled();
  });

  test('removeTags entry is not a string → 400 INVALID_TAGS', async () => {
    const res = await request(makeApp())
      .patch('/api/wellness/patients/bulk-tags')
      .send({ patientIds: [1], removeTags: [123] });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_TAGS');
  });
});

describe('PATCH /api/wellness/patients/bulk-tags — V4 idempotent: no tags + removeTags=X', () => {
  test('patient with null tags + removeTags=["X"] → zero update calls', async () => {
    prisma.patient.findMany.mockResolvedValue([
      makePatientRow(1, null), // never had tags
    ]);
    const res = await request(makeApp())
      .patch('/api/wellness/patients/bulk-tags')
      .send({ patientIds: [1], removeTags: ['X'] });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ updated: 0, removed: 0 });
    expect(prisma.patient.update).not.toHaveBeenCalled();
  });

  test('patient with empty-array tags + removeTags=["X"] → zero update calls', async () => {
    prisma.patient.findMany.mockResolvedValue([
      makePatientRow(1, JSON.stringify([])),
    ]);
    const res = await request(makeApp())
      .patch('/api/wellness/patients/bulk-tags')
      .send({ patientIds: [1], removeTags: ['X'] });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ updated: 0, removed: 0 });
    expect(prisma.patient.update).not.toHaveBeenCalled();
  });
});

// ─── Response envelope (E1) ────────────────────────────────────────────

describe('PATCH /api/wellness/patients/bulk-tags — E1 response envelope', () => {
  test('always includes both updated and removed count fields', async () => {
    prisma.patient.findMany.mockResolvedValue([
      makePatientRow(1, JSON.stringify(['existing'])),
    ]);
    const res = await request(makeApp())
      .patch('/api/wellness/patients/bulk-tags')
      .send({ patientIds: [1], addTags: ['new'] });
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('updated');
    expect(res.body).toHaveProperty('removed');
    expect(typeof res.body.updated).toBe('number');
    expect(typeof res.body.removed).toBe('number');
  });
});
