// @ts-check
/**
 * Unit + integration tests for backend/routes/ab_tests.js — pins the
 * A/B-test experiment CRUD + lifecycle + tracking contract that powers
 * the marketing-AB-test admin surface.
 *
 * Why this file exists
 * ────────────────────
 *   routes/ab_tests.js is a 266-LOC CRUD module that ALSO embeds a
 *   non-trivial stats helper (`computeStats`) for click-through-rate +
 *   significance + leader-declaration, plus per-variant counter
 *   increments via `prisma.abTest.update({ data: { variantASent: { increment: 1 } } })`.
 *   These five things in one file (CRUD + serialize + computeStats +
 *   counter increment + variant validation) make it a perfect spot for
 *   a future regression — and the route was historically silent (zero
 *   tests) before this commit.
 *
 *   Sanitization angle: v3.4.11 097ef5a added sanitizeText/sanitizeJsonForStringColumn
 *   to the POST + PUT bodies (variantA / variantB are JSON-string columns,
 *   the same #398/#447 class as lead_routing.js + sequences.js). We pin
 *   the post-sanitize shape so a future "let me revert that sanitize import"
 *   refactor reds the test instead of silently shipping XSS.
 *
 * What this file pins
 * ───────────────────
 *   1. GET / returns serialized rows scoped to the request tenant, each
 *      decorated with computeStats() output.
 *   2. POST / requires `name`; null/missing → 400.
 *   3. POST / sanitizes name (HTML-strip) + stringifies variant JSON for the
 *      String? @db.Text column.
 *   4. POST / defaults status to 'DRAFT' and uses req.user.tenantId.
 *   5. GET /:id 404 when the row belongs to a different tenant (tenant
 *      isolation gate — the tenantOf() helper is the load-bearing call).
 *   6. PUT /:id round-trips partial updates (only supplied fields land
 *      in the `data` object — undefined fields are skipped).
 *   7. PUT /:id sanitizes variant JSON on update (parity with POST).
 *   8. DELETE /:id returns { success: true } and emits the prisma.delete call.
 *   9. POST /:id/start flips status from DRAFT → RUNNING.
 *  10. POST /:id/track validates variant ∈ {A,B} and action ∈ {sent,clicked}
 *      and increments the matching `variant{A|B}{Sent|Clicked}` counter by 1.
 *  11. POST /:id/declare-winner validates winner ∈ {A,B}, sets winningVariant
 *      AND flips status to COMPLETED in one update.
 *  12. GET /:id/stats returns the computeStats() envelope with id/name/status/
 *      winningVariant pre-flattened.
 *  13. computeStats CTR + significance edge cases (zero-sent guard, leader
 *      'TIE' when CTRs match, significance threshold at >5% CTR diff AND
 *      totalSent > 100).
 *
 * Test pattern
 * ────────────
 *   Mirror of backend/test/routes/communications.test.js + surveys.test.js —
 *   prisma singleton monkey-patch BEFORE the router require, then mount the
 *   router into a bare express app with a fake req.user injector and drive
 *   it via supertest.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

import prisma from '../../lib/prisma.js';

// Prisma singleton patching — must happen BEFORE the router is required,
// since the router's top-level `require('../lib/prisma')` resolves at
// import time and captures whatever object prisma.abTest points at then.
prisma.abTest = {
  findMany: vi.fn(),
  findFirst: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
};

import express from 'express';
import request from 'supertest';
import { createRequire } from 'node:module';
const requireCJS = createRequire(import.meta.url);
const abTestsRouter = requireCJS('../../routes/ab_tests');

function makeApp({ tenantId = 1, userId = 7 } = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { userId, tenantId };
    next();
  });
  app.use('/api/ab-tests', abTestsRouter);
  return app;
}

beforeEach(() => {
  prisma.abTest.findMany.mockReset();
  prisma.abTest.findFirst.mockReset();
  prisma.abTest.create.mockReset();
  prisma.abTest.update.mockReset();
  prisma.abTest.delete.mockReset();
});

// ── GET / — list AB tests ──────────────────────────────────────────

describe('GET / — list AB tests', () => {
  test('returns tenant-scoped rows decorated with computeStats', async () => {
    prisma.abTest.findMany.mockResolvedValue([
      {
        id: 1,
        tenantId: 1,
        name: 'Subject-line probe',
        variantA: '{"subject":"Hello"}',
        variantB: '{"subject":"Hi"}',
        variantASent: 60,
        variantAClicked: 6,
        variantBSent: 80,
        variantBClicked: 4,
        status: 'RUNNING',
      },
    ]);

    const res = await request(makeApp()).get('/api/ab-tests');
    expect(res.status).toBe(200);

    // Tenant scope on the findMany call.
    const args = prisma.abTest.findMany.mock.calls[0][0];
    expect(args.where).toEqual({ tenantId: 1 });
    expect(args.orderBy).toEqual({ createdAt: 'desc' });

    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(1);
    // JSON-string columns are parsed back to objects in the response.
    expect(res.body[0].variantA).toEqual({ subject: 'Hello' });
    expect(res.body[0].variantB).toEqual({ subject: 'Hi' });
    // computeStats envelope decoration.
    expect(res.body[0].stats).toBeDefined();
    expect(res.body[0].stats.variantA.sent).toBe(60);
    expect(res.body[0].stats.variantA.clicked).toBe(6);
    expect(res.body[0].stats.variantA.ctr).toBe(10);
    expect(res.body[0].stats.variantB.ctr).toBe(5);
    expect(res.body[0].stats.totalSent).toBe(140);
    expect(res.body[0].stats.leader).toBe('A');
  });

  test('500 envelope on Prisma fault', async () => {
    prisma.abTest.findMany.mockRejectedValue(new Error('db down'));
    const res = await request(makeApp()).get('/api/ab-tests');
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Failed to fetch AB tests' });
  });
});

// ── POST / — create ────────────────────────────────────────────────

describe('POST / — create AB test', () => {
  test('400 when name is missing', async () => {
    const res = await request(makeApp())
      .post('/api/ab-tests')
      .send({ campaignId: 1 });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'name is required' });
    expect(prisma.abTest.create).not.toHaveBeenCalled();
  });

  test('persists row with sanitized name, JSON-stringified variants, DRAFT status, and tenant scope', async () => {
    prisma.abTest.create.mockImplementation(({ data }) =>
      Promise.resolve({ id: 99, ...data })
    );

    const res = await request(makeApp({ tenantId: 42 }))
      .post('/api/ab-tests')
      .send({
        name: '  Q3 Plan & Brief<script>alert(1)</script>  ',
        campaignId: '7',
        variantA: { subject: 'A', body: 'one<script>x</script>' },
        variantB: { subject: 'B' },
      });

    expect(res.status).toBe(201);
    expect(prisma.abTest.create).toHaveBeenCalledTimes(1);
    const args = prisma.abTest.create.mock.calls[0][0];

    // sanitizeText trims + strips <script> but preserves the `&` character.
    expect(args.data.name).toBe('Q3 Plan & Brief');
    // campaignId coerced to Number.
    expect(args.data.campaignId).toBe(7);
    // Status default + tenant injection.
    expect(args.data.status).toBe('DRAFT');
    expect(args.data.tenantId).toBe(42);

    // Variants are JSON strings (for the String? @db.Text column).
    expect(typeof args.data.variantA).toBe('string');
    expect(typeof args.data.variantB).toBe('string');
    const decodedA = JSON.parse(args.data.variantA);
    // sanitizeJsonForStringColumn strips <script> from the nested string.
    expect(decodedA.body).toBe('one');
    expect(decodedA.subject).toBe('A');

    // Response serialize() parses variants back to objects.
    expect(res.body.variantA).toEqual({ subject: 'A', body: 'one' });
    expect(res.body.variantB).toEqual({ subject: 'B' });
  });

  test('campaignId omitted falls to null', async () => {
    prisma.abTest.create.mockImplementation(({ data }) =>
      Promise.resolve({ id: 100, ...data })
    );

    const res = await request(makeApp())
      .post('/api/ab-tests')
      .send({ name: 'no-campaign-link' });

    expect(res.status).toBe(201);
    const args = prisma.abTest.create.mock.calls[0][0];
    expect(args.data.campaignId).toBeNull();
  });
});

// ── GET /:id ───────────────────────────────────────────────────────

describe('GET /:id — detail', () => {
  test('returns row with computeStats when tenant matches', async () => {
    prisma.abTest.findFirst.mockResolvedValue({
      id: 5,
      tenantId: 1,
      name: 'Detail probe',
      variantA: '{}',
      variantB: '{}',
      variantASent: 0,
      variantAClicked: 0,
      variantBSent: 0,
      variantBClicked: 0,
      status: 'DRAFT',
    });
    const res = await request(makeApp()).get('/api/ab-tests/5');
    expect(res.status).toBe(200);
    expect(prisma.abTest.findFirst).toHaveBeenCalledWith({
      where: { id: 5, tenantId: 1 },
    });
    // Zero-sent guard: leader is null (the route returns null when
    // both sent counts are zero) rather than crashing on a div-by-zero.
    expect(res.body.stats.leader).toBeNull();
    expect(res.body.stats.totalSent).toBe(0);
    expect(res.body.stats.significant).toBe(false);
  });

  test('404 when the row belongs to a different tenant (tenant isolation gate)', async () => {
    // findFirst returns null because the WHERE clause includes tenantId
    // and the row lives under a different tenant.
    prisma.abTest.findFirst.mockResolvedValue(null);
    const res = await request(makeApp({ tenantId: 99 })).get('/api/ab-tests/5');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'AB test not found' });
    // Critical: the findFirst call MUST include tenantId in the where —
    // dropping it would expose cross-tenant reads.
    const args = prisma.abTest.findFirst.mock.calls[0][0];
    expect(args.where.tenantId).toBe(99);
  });
});

// ── PUT /:id — update ──────────────────────────────────────────────

describe('PUT /:id — update', () => {
  test('partial update only includes supplied fields (undefined fields skipped)', async () => {
    prisma.abTest.findFirst.mockResolvedValue({ id: 5, tenantId: 1 });
    prisma.abTest.update.mockImplementation(({ data }) =>
      Promise.resolve({ id: 5, tenantId: 1, name: data.name, variantA: '{}', variantB: '{}' })
    );

    const res = await request(makeApp())
      .put('/api/ab-tests/5')
      .send({ name: 'Renamed' });

    expect(res.status).toBe(200);
    const args = prisma.abTest.update.mock.calls[0][0];
    expect(args.where).toEqual({ id: 5 });
    expect(args.data).toEqual({ name: 'Renamed' });
    // None of the other write fields leak into the update data.
    expect(args.data.variantA).toBeUndefined();
    expect(args.data.status).toBeUndefined();
    expect(args.data.winningVariant).toBeUndefined();
  });

  test('sanitizes variantA on update (parity with POST contract)', async () => {
    prisma.abTest.findFirst.mockResolvedValue({ id: 5, tenantId: 1 });
    prisma.abTest.update.mockImplementation(({ data }) =>
      Promise.resolve({ id: 5, tenantId: 1, variantA: data.variantA, variantB: '{}' })
    );

    await request(makeApp())
      .put('/api/ab-tests/5')
      .send({ variantA: { subject: '<img src=x onerror=alert(1)>real-subject' } });

    const args = prisma.abTest.update.mock.calls[0][0];
    expect(typeof args.data.variantA).toBe('string');
    const decoded = JSON.parse(args.data.variantA);
    // <img> stripped, text content preserved.
    expect(decoded.subject).toBe('real-subject');
  });

  test('404 when row missing (no update call fired)', async () => {
    prisma.abTest.findFirst.mockResolvedValue(null);
    const res = await request(makeApp())
      .put('/api/ab-tests/999')
      .send({ name: 'ghost' });
    expect(res.status).toBe(404);
    expect(prisma.abTest.update).not.toHaveBeenCalled();
  });
});

// ── DELETE /:id ────────────────────────────────────────────────────

describe('DELETE /:id', () => {
  test('returns { success: true } and emits prisma.delete', async () => {
    prisma.abTest.findFirst.mockResolvedValue({ id: 5, tenantId: 1 });
    prisma.abTest.delete.mockResolvedValue({ id: 5 });

    const res = await request(makeApp()).delete('/api/ab-tests/5');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
    expect(prisma.abTest.delete).toHaveBeenCalledWith({ where: { id: 5 } });
  });

  test('404 when row missing (delete NOT called)', async () => {
    prisma.abTest.findFirst.mockResolvedValue(null);
    const res = await request(makeApp()).delete('/api/ab-tests/999');
    expect(res.status).toBe(404);
    expect(prisma.abTest.delete).not.toHaveBeenCalled();
  });
});

// ── POST /:id/start ────────────────────────────────────────────────

describe('POST /:id/start', () => {
  test('flips status to RUNNING', async () => {
    prisma.abTest.findFirst.mockResolvedValue({ id: 5, tenantId: 1, status: 'DRAFT' });
    prisma.abTest.update.mockImplementation(({ data }) =>
      Promise.resolve({ id: 5, tenantId: 1, status: data.status, variantA: '{}', variantB: '{}' })
    );

    const res = await request(makeApp()).post('/api/ab-tests/5/start');
    expect(res.status).toBe(200);
    const args = prisma.abTest.update.mock.calls[0][0];
    expect(args.where).toEqual({ id: 5 });
    expect(args.data).toEqual({ status: 'RUNNING' });
    expect(res.body.status).toBe('RUNNING');
  });

  test('404 when row missing', async () => {
    prisma.abTest.findFirst.mockResolvedValue(null);
    const res = await request(makeApp()).post('/api/ab-tests/999/start');
    expect(res.status).toBe(404);
    expect(prisma.abTest.update).not.toHaveBeenCalled();
  });
});

// ── POST /:id/track ────────────────────────────────────────────────

describe('POST /:id/track — counter increment', () => {
  test('400 when variant is not A/B', async () => {
    const res = await request(makeApp())
      .post('/api/ab-tests/5/track')
      .send({ variant: 'C', action: 'sent' });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "variant must be 'A' or 'B'" });
    expect(prisma.abTest.findFirst).not.toHaveBeenCalled();
  });

  test('400 when action is not sent/clicked', async () => {
    const res = await request(makeApp())
      .post('/api/ab-tests/5/track')
      .send({ variant: 'A', action: 'opened' });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "action must be 'sent' or 'clicked'" });
  });

  test('increments variantBClicked by 1 for {variant:B, action:clicked}', async () => {
    prisma.abTest.findFirst.mockResolvedValue({ id: 5, tenantId: 1 });
    prisma.abTest.update.mockImplementation(() =>
      Promise.resolve({ id: 5, tenantId: 1, variantA: '{}', variantB: '{}', variantBClicked: 1 })
    );

    const res = await request(makeApp())
      .post('/api/ab-tests/5/track')
      .send({ variant: 'B', action: 'clicked' });

    expect(res.status).toBe(200);
    const args = prisma.abTest.update.mock.calls[0][0];
    expect(args.where).toEqual({ id: 5 });
    expect(args.data).toEqual({ variantBClicked: { increment: 1 } });
  });

  test('increments variantASent by 1 for {variant:A, action:sent}', async () => {
    prisma.abTest.findFirst.mockResolvedValue({ id: 5, tenantId: 1 });
    prisma.abTest.update.mockImplementation(() =>
      Promise.resolve({ id: 5, tenantId: 1, variantA: '{}', variantB: '{}' })
    );

    await request(makeApp())
      .post('/api/ab-tests/5/track')
      .send({ variant: 'A', action: 'sent' });

    const args = prisma.abTest.update.mock.calls[0][0];
    expect(args.data).toEqual({ variantASent: { increment: 1 } });
  });

  test('404 when row missing — update not called', async () => {
    prisma.abTest.findFirst.mockResolvedValue(null);
    const res = await request(makeApp())
      .post('/api/ab-tests/999/track')
      .send({ variant: 'A', action: 'sent' });
    expect(res.status).toBe(404);
    expect(prisma.abTest.update).not.toHaveBeenCalled();
  });
});

// ── POST /:id/declare-winner ───────────────────────────────────────

describe('POST /:id/declare-winner', () => {
  test('400 when winner not A/B', async () => {
    const res = await request(makeApp())
      .post('/api/ab-tests/5/declare-winner')
      .send({ winner: 'TIE' });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "winner must be 'A' or 'B'" });
  });

  test('sets winningVariant + flips status to COMPLETED in one update', async () => {
    prisma.abTest.findFirst.mockResolvedValue({ id: 5, tenantId: 1 });
    prisma.abTest.update.mockImplementation(({ data }) =>
      Promise.resolve({
        id: 5, tenantId: 1, variantA: '{}', variantB: '{}',
        winningVariant: data.winningVariant, status: data.status,
      })
    );

    const res = await request(makeApp())
      .post('/api/ab-tests/5/declare-winner')
      .send({ winner: 'A' });

    expect(res.status).toBe(200);
    const args = prisma.abTest.update.mock.calls[0][0];
    expect(args.where).toEqual({ id: 5 });
    expect(args.data).toEqual({ winningVariant: 'A', status: 'COMPLETED' });
    expect(res.body.winningVariant).toBe('A');
    expect(res.body.status).toBe('COMPLETED');
  });
});

// ── GET /:id/stats — computeStats edge cases ───────────────────────

describe('GET /:id/stats — computeStats envelope + edge cases', () => {
  test('flattens id/name/status/winningVariant + computeStats fields', async () => {
    prisma.abTest.findFirst.mockResolvedValue({
      id: 5, tenantId: 1, name: 'Stats probe', status: 'COMPLETED', winningVariant: 'A',
      variantA: '{}', variantB: '{}',
      variantASent: 50, variantAClicked: 5, variantBSent: 50, variantBClicked: 1,
    });

    const res = await request(makeApp()).get('/api/ab-tests/5/stats');
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(5);
    expect(res.body.name).toBe('Stats probe');
    expect(res.body.status).toBe('COMPLETED');
    expect(res.body.winningVariant).toBe('A');
    expect(res.body.variantA.ctr).toBe(10);   // 5/50 * 100
    expect(res.body.variantB.ctr).toBe(2);    // 1/50 * 100
    expect(res.body.totalSent).toBe(100);
    expect(res.body.leader).toBe('A');
  });

  test('CTR-tie returns leader=TIE when both variants have equal CTR', async () => {
    prisma.abTest.findFirst.mockResolvedValue({
      id: 5, tenantId: 1, name: 't', status: 'RUNNING', winningVariant: null,
      variantA: '{}', variantB: '{}',
      variantASent: 100, variantAClicked: 10,
      variantBSent: 50, variantBClicked: 5, // both 10% CTR
    });
    const res = await request(makeApp()).get('/api/ab-tests/5/stats');
    expect(res.status).toBe(200);
    expect(res.body.variantA.ctr).toBe(10);
    expect(res.body.variantB.ctr).toBe(10);
    expect(res.body.leader).toBe('TIE');
  });

  test('significance threshold — totalSent <= 100 OR ctr-diff <= 5%% returns significant=false', async () => {
    // totalSent = 100 exactly (NOT > 100), so significant=false even though
    // CTR diff is 20 percentage points.
    prisma.abTest.findFirst.mockResolvedValue({
      id: 5, tenantId: 1, name: 't', status: 'RUNNING', winningVariant: null,
      variantA: '{}', variantB: '{}',
      variantASent: 50, variantAClicked: 15, // 30% CTR
      variantBSent: 50, variantBClicked: 5,  // 10% CTR
    });
    const res = await request(makeApp()).get('/api/ab-tests/5/stats');
    expect(res.status).toBe(200);
    expect(res.body.totalSent).toBe(100);
    expect(res.body.significant).toBe(false);
  });

  test('significance true when CTR diff > 5%% AND totalSent > 100', async () => {
    prisma.abTest.findFirst.mockResolvedValue({
      id: 5, tenantId: 1, name: 't', status: 'RUNNING', winningVariant: null,
      variantA: '{}', variantB: '{}',
      variantASent: 100, variantAClicked: 30, // 30% CTR
      variantBSent: 50, variantBClicked: 5,   // 10% CTR
    });
    const res = await request(makeApp()).get('/api/ab-tests/5/stats');
    expect(res.status).toBe(200);
    expect(res.body.totalSent).toBe(150);
    expect(res.body.significant).toBe(true);
    expect(res.body.leader).toBe('A');
  });

  test('404 when stats requested for unknown id', async () => {
    prisma.abTest.findFirst.mockResolvedValue(null);
    const res = await request(makeApp()).get('/api/ab-tests/999/stats');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'AB test not found' });
  });
});
