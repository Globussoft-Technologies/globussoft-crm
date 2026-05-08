// @ts-check
/**
 * Unit tests for #601 — Visits revenue rollup.
 *
 * Pins the rollup formula on /api/wellness/reports/visit (list) +
 * /api/wellness/reports/visit/:id (per-patient detail):
 *
 *   revenue(visit) = SUM(invoice.amount WHERE invoice.visitId=visit.id AND invoice.status='PAID')
 *                    OR visit.amountCharged when no paid invoice is linked.
 *
 * What this file pins
 * ───────────────────
 *   1. Per-visit `revenue` = sum of paid-invoice amounts when one or more
 *      paid invoices reference the visit (canonical case).
 *   2. Per-visit `revenue` falls back to visit.amountCharged when no paid
 *      invoice exists yet (cash-in-hand / express-checkout case).
 *   3. Page-level `totalRevenue` is the sum across the FULL window (not
 *      just the page) so the KPI matches Billing's headline figure.
 *   4. Detail endpoint surfaces per-visit `revenue` field on each row.
 *   5. Tenant scope: rollup queries always carry tenantId.
 *
 * Pre-#601 the controller was summing visit.amountCharged via groupBy and
 * never joined onto Invoice — issue body's "₹0 every row" was the case
 * where amountCharged was null (visits logged via flows that defer the
 * billing step) and no invoice rollup existed to backfill.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import prisma from '../../lib/prisma.js';

// Stub the prisma surfaces visitController touches.
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

const tenantId = 7;

const makeReqRes = (query = {}, params = {}) => {
  const req = { user: { tenantId, userId: 1, role: 'ADMIN' }, query, params };
  const res = {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
  return { req, res };
};

beforeEach(() => {
  prisma.visit.groupBy.mockReset();
  prisma.visit.findMany.mockReset();
  prisma.visit.count.mockReset();
  prisma.invoice.groupBy.mockReset();
  prisma.patient.findMany.mockReset();
  prisma.patient.findFirst.mockReset();
});

describe('visitController — #601 revenue rollup', () => {
  test('per-visit revenue uses SUM of paid invoices when linked', async () => {
    const yesterday = new Date(Date.now() - 86400000);
    // Page query: one patient, two visits.
    prisma.visit.groupBy
      .mockResolvedValueOnce([
        { patientId: 100, _count: { id: 2 }, _max: { visitDate: yesterday } },
      ])
      .mockResolvedValueOnce([{ patientId: 100 }]); // total count

    prisma.patient.findMany.mockResolvedValue([
      { id: 100, name: 'Asha Patel', phone: '+919999900001' },
    ]);

    // Visits in window for revenue map (page-scoped) + (full-window).
    const pageVisits = [
      { id: 11, patientId: 100, amountCharged: 5000 },
      { id: 12, patientId: 100, amountCharged: null }, // no inline charge
    ];
    prisma.visit.findMany
      .mockResolvedValueOnce(pageVisits)        // page-scope rollup
      .mockResolvedValueOnce(pageVisits);        // full-window rollup

    // Visit 11 has a PAID invoice for ₹6500 (overrides amountCharged).
    // Visit 12 has no paid invoice (will fall back to amountCharged=null → 0).
    prisma.invoice.groupBy.mockResolvedValue([
      { visitId: 11, _sum: { amount: 6500 } },
    ]);

    const { req, res } = makeReqRes();
    await getPatientsSummary(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveLength(1);
    // visit 11: 6500 (paid invoice wins) + visit 12: 0 (no fallback) = 6500
    expect(res.body.data[0].totalRevenue).toBe(6500);
    expect(res.body.totalRevenue).toBe(6500);
  });

  test('per-visit revenue falls back to amountCharged when no paid invoice', async () => {
    const yesterday = new Date(Date.now() - 86400000);
    prisma.visit.groupBy
      .mockResolvedValueOnce([
        { patientId: 200, _count: { id: 1 }, _max: { visitDate: yesterday } },
      ])
      .mockResolvedValueOnce([{ patientId: 200 }]);

    prisma.patient.findMany.mockResolvedValue([
      { id: 200, name: 'Rohan Kumar', phone: '+919999900002' },
    ]);

    const pageVisits = [{ id: 21, patientId: 200, amountCharged: 4200 }];
    prisma.visit.findMany
      .mockResolvedValueOnce(pageVisits)
      .mockResolvedValueOnce(pageVisits);

    // Empty paidByVisit — rollup falls back to amountCharged.
    prisma.invoice.groupBy.mockResolvedValue([]);

    const { req, res } = makeReqRes();
    await getPatientsSummary(req, res);

    expect(res.body.data[0].totalRevenue).toBe(4200);
    expect(res.body.totalRevenue).toBe(4200);
  });

  test('page-level totalRevenue spans full window, not just current page', async () => {
    const today = new Date();
    // Page returns 1 of 2 patients (skip/limit). Full-window rollup must
    // still see both patients' revenue.
    prisma.visit.groupBy
      .mockResolvedValueOnce([
        { patientId: 100, _count: { id: 1 }, _max: { visitDate: today } },
      ])
      .mockResolvedValueOnce([{ patientId: 100 }, { patientId: 200 }]);

    prisma.patient.findMany.mockResolvedValue([
      { id: 100, name: 'Asha', phone: '+91...' },
    ]);

    prisma.visit.findMany
      .mockResolvedValueOnce([{ id: 11, patientId: 100, amountCharged: 1000 }]) // page
      .mockResolvedValueOnce([                                                    // full-window
        { id: 11, patientId: 100, amountCharged: 1000 },
        { id: 21, patientId: 200, amountCharged: 2000 },
      ]);

    prisma.invoice.groupBy.mockResolvedValue([]);

    const { req, res } = makeReqRes({ skip: '0', limit: '1' });
    await getPatientsSummary(req, res);

    expect(res.body.data[0].totalRevenue).toBe(1000); // page row only sees own
    expect(res.body.totalRevenue).toBe(3000);          // full window sums both
  });

  test('detail endpoint attaches `revenue` field to every visit row', async () => {
    prisma.patient.findFirst.mockResolvedValue({
      id: 100, name: 'Asha', phone: '+91...',
    });

    const visits = [
      { id: 11, patientId: 100, amountCharged: 5000, visitDate: new Date(), notes: 'first' },
      { id: 12, patientId: 100, amountCharged: 3000, visitDate: new Date(), notes: 'second' },
    ];
    prisma.visit.findMany.mockResolvedValue(visits);
    prisma.visit.count.mockResolvedValue(2);

    // Visit 11 has a paid invoice; visit 12 falls back to amountCharged.
    prisma.invoice.groupBy.mockResolvedValue([
      { visitId: 11, _sum: { amount: 7500 } },
    ]);

    const { req, res } = makeReqRes({}, { id: '100' });
    await getPatientDetails(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.data.visits).toHaveLength(2);
    expect(res.body.data.visits[0].revenue).toBe(7500); // paid wins
    expect(res.body.data.visits[1].revenue).toBe(3000); // fallback
  });

  test('tenant scope: invoice.groupBy is called with PAID status filter', async () => {
    const yesterday = new Date(Date.now() - 86400000);
    prisma.visit.groupBy
      .mockResolvedValueOnce([
        { patientId: 100, _count: { id: 1 }, _max: { visitDate: yesterday } },
      ])
      .mockResolvedValueOnce([{ patientId: 100 }]);

    prisma.patient.findMany.mockResolvedValue([
      { id: 100, name: 'Asha', phone: '+91...' },
    ]);

    const pageVisits = [{ id: 11, patientId: 100, amountCharged: 1000 }];
    prisma.visit.findMany
      .mockResolvedValueOnce(pageVisits)
      .mockResolvedValueOnce(pageVisits);
    prisma.invoice.groupBy.mockResolvedValue([]);

    const { req, res } = makeReqRes();
    await getPatientsSummary(req, res);

    // First invoice.groupBy call (page rollup)
    const firstCall = prisma.invoice.groupBy.mock.calls[0][0];
    expect(firstCall.where.status).toEqual({ in: ['PAID', 'paid'] });
    expect(firstCall.where.visitId.in).toContain(11);

    // Visit-side queries always carry tenantId
    const allFindManyCalls = prisma.visit.findMany.mock.calls.map((c) => c[0]);
    for (const call of allFindManyCalls) {
      expect(call.where.tenantId).toBe(tenantId);
    }
  });
});
