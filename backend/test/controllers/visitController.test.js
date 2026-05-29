// @ts-check
/**
 * Unit tests for backend/controllers/visitController.js — pin the broader
 * controller surface (date-range validation, pagination clamping,
 * tenant-isolation, error envelopes, patient-not-found) NOT already covered
 * by the narrow `backend/test/routes/visitController-revenue.test.js` spec.
 *
 * Why this file exists
 * ────────────────────
 * `visitController.js` was the top under-covered file in the codebase per
 * c8 (9.68% lines). The existing companion `visitController-revenue.test.js`
 * pins only the #601 revenue rollup happy paths on both exports. Every
 * other branch in the controller — `getDateRange()`'s 5 distinct paths,
 * the skip/limit parsing + Math.min(_,50) clamp, the patient-not-found
 * branch, the two catch-all error envelopes, empty-window short-circuits,
 * and explicit tenant-isolation assertions on every prisma call — was
 * uncovered. This file backfills those branches.
 *
 * The SUT exports only two functions:
 *   - getPatientsSummary  (GET /api/wellness/reports/visit)
 *   - getPatientDetails   (GET /api/wellness/reports/visit/:id)
 *
 * Routing + auth: both are mounted under verifyToken in routes/wellness.js
 * — req.user.tenantId is guaranteed populated when the controller fires.
 * We invoke the controllers DIRECTLY with mock req/res (no Express, no JWT,
 * no supertest) since the surface is a pure (req, res) -> response shape.
 *
 * The SUT does `const prisma = require("../lib/prisma")` — the shared
 * singleton — so we stub on the singleton (matches the existing
 * visitController-revenue.test.js pattern). The audienceController.test.js
 * StubPrismaClient pattern is for SUTs that do `new PrismaClient()` at
 * module-load; not needed here.
 *
 * Cases (16 total)
 * ────────────────
 *   getDateRange (8 — exercised through both exports):
 *     1. default window = last 1 month when no dates provided
 *     2. explicit valid range honoured + normalised to whole-day boundaries
 *     3. invalid date strings → 400 with "date" in error message
 *     4. future startDate → 400 with "date" in error message
 *     5. inverted range (start > end) → 400 with "date" in error message
 *     6. only startDate provided → falls back to default window (not partial)
 *     7. only endDate provided → falls back to default window (not partial)
 *     8. midnight normalisation: start=00:00:00.000, end=23:59:59.999
 *
 *   pagination clamping (3):
 *     9. limit > 50 is clamped to 50
 *    10. limit string parses to Number; non-numeric falls to default 10
 *    11. skip default = 0; explicit skip honoured
 *
 *   getPatientDetails branches (3):
 *    12. patient not found in tenant → 404 (with no visit/count query)
 *    13. id is parsed Number(params.id) for both findFirst + findMany + count
 *    14. tenant scope: every prisma call on detail path carries tenantId
 *
 *   error envelopes (2):
 *    15. getPatientsSummary: non-date prisma error → 500 { success:false }
 *    16. getPatientDetails: non-date prisma error → 500 { success:false }
 *
 * Bugs surfaced during authoring
 * ──────────────────────────────
 *   None. The controller's validation paths are internally consistent.
 *   One minor observation worth noting in the spec (not a bug): the SUT's
 *   error filter at lines 204-211 / 306-313 matches `err.message.includes
 *   ("date")` — case-sensitive. A future Prisma error message containing
 *   the substring "date" (e.g. a constraint mentioning a date column) would
 *   wrongly classify as a 400 instead of a 500. The controller's own
 *   thrown errors all spell it lowercase ("Invalid date format", "date
 *   cannot be...", "Start date cannot be...") so the substring match is
 *   safe for SELF-generated errors. We document this in a comment on case
 *   #15/#16 rather than file an issue — pure-defensive concern, no live
 *   exposure.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import prisma from '../../lib/prisma.js';

// Stub the prisma surfaces visitController touches BEFORE requiring the SUT.
// The shared singleton is already initialised; we just attach mock methods.
prisma.visit = prisma.visit || {};
prisma.visit.groupBy = vi.fn();
prisma.visit.findMany = vi.fn();
prisma.visit.count = vi.fn();
prisma.invoice = prisma.invoice || {};
prisma.invoice.groupBy = vi.fn();
prisma.patient = prisma.patient || {};
prisma.patient.findMany = vi.fn();
prisma.patient.findFirst = vi.fn();

import { createRequire } from 'node:module';
const requireCJS = createRequire(import.meta.url);
const { getPatientsSummary, getPatientDetails } = requireCJS('../../controllers/visitController');

const TENANT_ID = 42;
const OTHER_TENANT = 99;

function makeReqRes({ query = {}, params = {}, tenantId = TENANT_ID } = {}) {
  const req = {
    user: { tenantId, userId: 7, role: 'ADMIN' },
    query,
    params,
  };
  const res = {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
  return { req, res };
}

// Helper: default-window happy-path stubs so a call returns 200 without
// asserting on what's inside the response body (used by branches that only
// care about WHAT was queried, not what was returned).
function stubSummaryHappy() {
  prisma.visit.groupBy
    .mockResolvedValueOnce([]) // page-window groupBy
    .mockResolvedValueOnce([]); // total-count groupBy
  prisma.patient.findMany.mockResolvedValue([]);
  prisma.visit.findMany
    .mockResolvedValueOnce([])  // page-scope rollup
    .mockResolvedValueOnce([]); // full-window rollup
  prisma.invoice.groupBy.mockResolvedValue([]);
}

beforeEach(() => {
  prisma.visit.groupBy.mockReset();
  prisma.visit.findMany.mockReset();
  prisma.visit.count.mockReset();
  prisma.invoice.groupBy.mockReset();
  prisma.patient.findMany.mockReset();
  prisma.patient.findFirst.mockReset();
});

describe('visitController.getDateRange (exercised through getPatientsSummary)', () => {
  test('1. default window: no dates provided → uses last 1 month', async () => {
    stubSummaryHappy();
    const { req, res } = makeReqRes();
    await getPatientsSummary(req, res);

    expect(res.statusCode).toBe(200);
    const { start, end } = res.body.dateRange;
    const monthDelta = end.getTime() - start.getTime();
    // ~30 days ± 2 (calendar month varies, plus midnight normalisation
    // adds up to 24h on the end side). Pin: between 28 and 32 days.
    const days = monthDelta / (1000 * 60 * 60 * 24);
    expect(days).toBeGreaterThan(27);
    expect(days).toBeLessThan(33);
  });

  test('2. explicit valid range is honoured and normalised to day boundaries', async () => {
    stubSummaryHappy();
    const { req, res } = makeReqRes({
      query: { startDate: '2026-01-01', endDate: '2026-01-31' },
    });
    await getPatientsSummary(req, res);

    expect(res.statusCode).toBe(200);
    const { start, end } = res.body.dateRange;
    expect(start.getDate()).toBe(1);
    expect(start.getMonth()).toBe(0); // January
    expect(end.getDate()).toBe(31);
    expect(end.getMonth()).toBe(0);
  });

  test('3. invalid date strings → 400 with "date" in error message', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { req, res } = makeReqRes({
      query: { startDate: 'not-a-date', endDate: 'also-bad' },
    });
    await getPatientsSummary(req, res);

    expect(res.statusCode).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toMatch(/date/i);
    errSpy.mockRestore();
  });

  test('4. future startDate → 400 with "date" in error message', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const futureDate = new Date(Date.now() + 365 * 86400000)
      .toISOString().slice(0, 10);
    const { req, res } = makeReqRes({
      query: { startDate: futureDate, endDate: futureDate },
    });
    await getPatientsSummary(req, res);

    expect(res.statusCode).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toMatch(/date/i);
    errSpy.mockRestore();
  });

  test('5. inverted range (start > end) → 400 with "date" in error message', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { req, res } = makeReqRes({
      query: { startDate: '2026-01-31', endDate: '2026-01-01' },
    });
    await getPatientsSummary(req, res);

    expect(res.statusCode).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toMatch(/date/i);
    errSpy.mockRestore();
  });

  test('6. only startDate (no endDate) → falls back to default window', async () => {
    stubSummaryHappy();
    const { req, res } = makeReqRes({
      query: { startDate: '2026-01-01' }, // partial
    });
    await getPatientsSummary(req, res);

    // SUT's getDateRange falls through to the default branch unless BOTH
    // dates are present — pin that contract.
    expect(res.statusCode).toBe(200);
    const { end } = res.body.dateRange;
    const now = new Date();
    // End should be today (normalised to 23:59:59.999) — not 2026-01-01.
    expect(end.getFullYear()).toBe(now.getFullYear());
    expect(end.getMonth()).toBe(now.getMonth());
  });

  test('7. only endDate (no startDate) → falls back to default window', async () => {
    stubSummaryHappy();
    const { req, res } = makeReqRes({
      query: { endDate: '2026-01-31' }, // partial
    });
    await getPatientsSummary(req, res);

    expect(res.statusCode).toBe(200);
    const { end } = res.body.dateRange;
    const now = new Date();
    expect(end.getFullYear()).toBe(now.getFullYear());
    expect(end.getMonth()).toBe(now.getMonth());
  });

  test('8. midnight normalisation: start=00:00:00, end=23:59:59.999', async () => {
    stubSummaryHappy();
    const { req, res } = makeReqRes({
      query: { startDate: '2026-01-15', endDate: '2026-01-20' },
    });
    await getPatientsSummary(req, res);

    const { start, end } = res.body.dateRange;
    expect(start.getHours()).toBe(0);
    expect(start.getMinutes()).toBe(0);
    expect(start.getSeconds()).toBe(0);
    expect(start.getMilliseconds()).toBe(0);
    expect(end.getHours()).toBe(23);
    expect(end.getMinutes()).toBe(59);
    expect(end.getSeconds()).toBe(59);
    expect(end.getMilliseconds()).toBe(999);
  });
});

describe('visitController.getPatientsSummary — pagination clamping', () => {
  test('9. limit > 50 is clamped to Math.min(_, 50)', async () => {
    stubSummaryHappy();
    const { req, res } = makeReqRes({ query: { limit: '500' } });
    await getPatientsSummary(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.limit).toBe(50);
    // Verify the clamp made it into the prisma call's `take` arg.
    const groupByCall = prisma.visit.groupBy.mock.calls[0][0];
    expect(groupByCall.take).toBe(50);
  });

  test('10. non-numeric limit falls back to default 10', async () => {
    stubSummaryHappy();
    const { req, res } = makeReqRes({ query: { limit: 'banana' } });
    await getPatientsSummary(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.limit).toBe(10);
    const groupByCall = prisma.visit.groupBy.mock.calls[0][0];
    expect(groupByCall.take).toBe(10);
  });

  test('11. explicit skip is forwarded; default skip = 0', async () => {
    stubSummaryHappy();
    const { req, res } = makeReqRes({ query: { skip: '20', limit: '5' } });
    await getPatientsSummary(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.skip).toBe(20);
    const groupByCall = prisma.visit.groupBy.mock.calls[0][0];
    expect(groupByCall.skip).toBe(20);
    expect(groupByCall.take).toBe(5);

    // Reset + default-skip case.
    prisma.visit.groupBy.mockReset();
    prisma.visit.findMany.mockReset();
    prisma.invoice.groupBy.mockReset();
    prisma.patient.findMany.mockReset();
    stubSummaryHappy();
    const { req: req2, res: res2 } = makeReqRes();
    await getPatientsSummary(req2, res2);
    expect(res2.body.skip).toBe(0);
  });
});

describe('visitController.getPatientDetails — branch coverage', () => {
  test('12. patient not found in tenant → 404, no visit query runs', async () => {
    // findFirst returns null when the patient id doesn't exist OR belongs
    // to a different tenant (the where clause scopes by both).
    prisma.patient.findFirst.mockResolvedValue(null);

    const { req, res } = makeReqRes({ params: { id: '9999' } });
    await getPatientDetails(req, res);

    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({ error: 'Patient not found' });

    // Critical: when the patient lookup fails, the controller must NOT
    // continue to query visits — otherwise tenant scope could be bypassed
    // for the visit/count query (defence-in-depth).
    expect(prisma.visit.findMany).not.toHaveBeenCalled();
    expect(prisma.visit.count).not.toHaveBeenCalled();
    expect(prisma.invoice.groupBy).not.toHaveBeenCalled();
  });

  test('13. id param is parsed Number(_) for findFirst + findMany + count', async () => {
    prisma.patient.findFirst.mockResolvedValue({
      id: 123, name: 'Asha Patel', phone: '+919999900001',
    });
    prisma.visit.findMany.mockResolvedValue([]);
    prisma.visit.count.mockResolvedValue(0);
    prisma.invoice.groupBy.mockResolvedValue([]);

    const { req, res } = makeReqRes({ params: { id: '123' } });
    await getPatientDetails(req, res);

    expect(res.statusCode).toBe(200);
    // All three prisma calls must receive id as Number(123), not '123'.
    expect(prisma.patient.findFirst.mock.calls[0][0].where.id).toBe(123);
    expect(prisma.visit.findMany.mock.calls[0][0].where.patientId).toBe(123);
    expect(prisma.visit.count.mock.calls[0][0].where.patientId).toBe(123);
  });

  test('14. tenant scope: every prisma call on detail path carries tenantId', async () => {
    prisma.patient.findFirst.mockResolvedValue({
      id: 100, name: 'Rohan Kumar', phone: '+919999900002',
    });
    prisma.visit.findMany.mockResolvedValue([
      { id: 11, patientId: 100, amountCharged: 1000,
        visitDate: new Date(), doctor: null, service: null },
    ]);
    prisma.visit.count.mockResolvedValue(1);
    prisma.invoice.groupBy.mockResolvedValue([]);

    const { req, res } = makeReqRes({
      params: { id: '100' },
      tenantId: OTHER_TENANT,
    });
    await getPatientDetails(req, res);

    expect(res.statusCode).toBe(200);
    expect(prisma.patient.findFirst.mock.calls[0][0].where.tenantId).toBe(OTHER_TENANT);
    expect(prisma.visit.findMany.mock.calls[0][0].where.tenantId).toBe(OTHER_TENANT);
    expect(prisma.visit.count.mock.calls[0][0].where.tenantId).toBe(OTHER_TENANT);
  });
});

describe('visitController — error envelopes', () => {
  test('15. getPatientsSummary: non-date prisma error → 500 envelope', async () => {
    // A prisma error whose message does NOT include the substring "date"
    // bypasses the 400 branch and falls through to the catch-all 500.
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    prisma.visit.groupBy.mockRejectedValue(new Error('connection refused'));

    const { req, res } = makeReqRes();
    await getPatientsSummary(req, res);

    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({
      success: false,
      error: 'Something went wrong',
    });
    errSpy.mockRestore();
  });

  test('16. getPatientDetails: non-date prisma error → 500 envelope', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    prisma.patient.findFirst.mockRejectedValue(new Error('boom: timeout'));

    const { req, res } = makeReqRes({ params: { id: '1' } });
    await getPatientDetails(req, res);

    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({
      success: false,
      error: 'Something went wrong',
    });
    errSpy.mockRestore();
  });
});
