// Unit tests for backend/lib/latePenaltyCalculation.js
//
// Pure-function unit pin over the late-payment-penalty math used by the
// Travel invoice /:id/late-penalty preview endpoint (PRD_TRAVEL_BILLING §3).
//
// Coverage classes:
//   - Closed-state envelope guards: Paid / Voided / Draft / undefined →
//     reason='INVOICE_CLOSED', penalty=0, applies=false.
//   - dueDate guards: null / undefined / unparseable → 'NO_DUE_DATE'.
//   - Reference-time guards: asOf on or before dueDate → 'NOT_YET_DUE'.
//   - Grace-window guard: daysOverdue ≤ graceDays → 'IN_GRACE_WINDOW'.
//   - Principal guard: chargeable but principal ≤ 0 → 'ZERO_PRINCIPAL'.
//   - Simple-mode math: round2(P * (annual/100) * (chargeableDays/365)).
//   - Flat-mode math: round2(P * (flat/100)) when chargeableDays>0,
//     independent of how many chargeable days.
//   - Half-up rounding boundary via Number.EPSILON nudge (0.005 → 0.01).
//   - Decimal/string coercion (Prisma Decimal arrives as string sometimes).
//   - NaN-defensive principal handling.
//   - Override clamping (negative grace/rate values clamped to 0).
//   - Whole-day floor for partial-day timestamps (no rounding up).
//   - PAYABLE_STATUSES export includes 'Partial'.
//   - mode='unknown' falls back to 'simple'.

import { describe, it, expect } from 'vitest';

const {
  computeLatePenalty,
  DEFAULT_GRACE_DAYS,
  DEFAULT_ANNUAL_RATE_PERCENT,
  DEFAULT_FLAT_FEE_PERCENT,
  PAYABLE_STATUSES,
} = await import('../../lib/latePenaltyCalculation.js');

// Deterministic anchor: 2026-05-01T00:00:00Z is "now" for all dated cases.
const ASOF = new Date('2026-05-01T00:00:00Z');

// Helper: dueDate 30 days before ASOF (2026-04-01T00:00:00Z).
const DUE_30_DAYS_AGO = new Date('2026-04-01T00:00:00Z');

describe('module exports — defaults and PAYABLE_STATUSES contract', () => {
  it('exports the expected default constants', () => {
    expect(DEFAULT_GRACE_DAYS).toBe(7);
    expect(DEFAULT_ANNUAL_RATE_PERCENT).toBe(18);
    expect(DEFAULT_FLAT_FEE_PERCENT).toBe(2);
  });

  it('PAYABLE_STATUSES contains both Issued and Partial (and only those)', () => {
    expect(PAYABLE_STATUSES).toEqual(['Issued', 'Partial']);
  });
});

describe('closed-state guards return reason=INVOICE_CLOSED', () => {
  it('status=Paid → INVOICE_CLOSED, penalty=0, applies=false', () => {
    const r = computeLatePenalty({
      invoiceAmount: 10000,
      dueDate: DUE_30_DAYS_AGO,
      status: 'Paid',
      asOf: ASOF,
    });
    expect(r.applies).toBe(false);
    expect(r.reason).toBe('INVOICE_CLOSED');
    expect(r.penalty).toBe(0);
    expect(r.newBalance).toBe(10000);
  });

  it('status=Voided → INVOICE_CLOSED, penalty=0', () => {
    const r = computeLatePenalty({
      invoiceAmount: 10000,
      dueDate: DUE_30_DAYS_AGO,
      status: 'Voided',
      asOf: ASOF,
    });
    expect(r.reason).toBe('INVOICE_CLOSED');
    expect(r.penalty).toBe(0);
  });

  it('status=Draft → INVOICE_CLOSED (Draft is not payable yet)', () => {
    const r = computeLatePenalty({
      invoiceAmount: 10000,
      dueDate: DUE_30_DAYS_AGO,
      status: 'Draft',
      asOf: ASOF,
    });
    expect(r.reason).toBe('INVOICE_CLOSED');
    expect(r.penalty).toBe(0);
  });

  it('status=undefined → INVOICE_CLOSED (missing status falls into the closed branch)', () => {
    const r = computeLatePenalty({
      invoiceAmount: 10000,
      dueDate: DUE_30_DAYS_AGO,
      asOf: ASOF,
    });
    expect(r.reason).toBe('INVOICE_CLOSED');
    expect(r.penalty).toBe(0);
  });
});

describe('dueDate guards', () => {
  it('dueDate=null → reason=NO_DUE_DATE', () => {
    const r = computeLatePenalty({
      invoiceAmount: 10000,
      dueDate: null,
      status: 'Issued',
      asOf: ASOF,
    });
    expect(r.reason).toBe('NO_DUE_DATE');
    expect(r.penalty).toBe(0);
    expect(r.applies).toBe(false);
  });

  it('dueDate=undefined → reason=NO_DUE_DATE', () => {
    const r = computeLatePenalty({
      invoiceAmount: 10000,
      status: 'Issued',
      asOf: ASOF,
    });
    expect(r.reason).toBe('NO_DUE_DATE');
    expect(r.penalty).toBe(0);
  });

  it('dueDate=unparseable string → reason=NO_DUE_DATE (NaN getTime guard)', () => {
    const r = computeLatePenalty({
      invoiceAmount: 10000,
      dueDate: 'this-is-not-a-date',
      status: 'Issued',
      asOf: ASOF,
    });
    expect(r.reason).toBe('NO_DUE_DATE');
    expect(r.penalty).toBe(0);
  });
});

describe('asOf on/before dueDate → NOT_YET_DUE', () => {
  it('asOf equal to dueDate → reason=NOT_YET_DUE, daysOverdue=0', () => {
    const r = computeLatePenalty({
      invoiceAmount: 10000,
      dueDate: ASOF,
      status: 'Issued',
      asOf: ASOF,
    });
    expect(r.reason).toBe('NOT_YET_DUE');
    expect(r.daysOverdue).toBe(0);
    expect(r.penalty).toBe(0);
    expect(r.applies).toBe(false);
  });

  it('asOf earlier than dueDate (preview before deadline) → NOT_YET_DUE', () => {
    const futureDue = new Date('2026-06-01T00:00:00Z');
    const r = computeLatePenalty({
      invoiceAmount: 10000,
      dueDate: futureDue,
      status: 'Issued',
      asOf: ASOF,
    });
    expect(r.reason).toBe('NOT_YET_DUE');
    expect(r.daysOverdue).toBe(0);
  });
});

describe('grace-window guard', () => {
  it('daysOverdue=5, default graceDays=7 → IN_GRACE_WINDOW, daysOverdue=5, chargeableDays=0', () => {
    const due = new Date('2026-04-26T00:00:00Z'); // 5 days before ASOF
    const r = computeLatePenalty({
      invoiceAmount: 10000,
      dueDate: due,
      status: 'Issued',
      asOf: ASOF,
    });
    expect(r.reason).toBe('IN_GRACE_WINDOW');
    expect(r.daysOverdue).toBe(5);
    expect(r.chargeableDays).toBe(0);
    expect(r.penalty).toBe(0);
    expect(r.graceDays).toBe(7);
  });

  it('daysOverdue exactly equal to graceDays → IN_GRACE_WINDOW (boundary)', () => {
    const due = new Date('2026-04-24T00:00:00Z'); // 7 days before ASOF
    const r = computeLatePenalty({
      invoiceAmount: 10000,
      dueDate: due,
      status: 'Issued',
      asOf: ASOF,
    });
    expect(r.daysOverdue).toBe(7);
    expect(r.chargeableDays).toBe(0);
    expect(r.reason).toBe('IN_GRACE_WINDOW');
  });
});

describe('principal guard outside grace window', () => {
  it('principal=0, 30 days overdue → ZERO_PRINCIPAL', () => {
    const r = computeLatePenalty({
      invoiceAmount: 0,
      dueDate: DUE_30_DAYS_AGO,
      status: 'Issued',
      asOf: ASOF,
    });
    expect(r.reason).toBe('ZERO_PRINCIPAL');
    expect(r.penalty).toBe(0);
    expect(r.daysOverdue).toBe(30);
    expect(r.chargeableDays).toBe(0);
  });

  it('principal negative (credit-note row) outside grace → ZERO_PRINCIPAL', () => {
    const r = computeLatePenalty({
      invoiceAmount: -100,
      dueDate: DUE_30_DAYS_AGO,
      status: 'Issued',
      asOf: ASOF,
    });
    expect(r.reason).toBe('ZERO_PRINCIPAL');
    expect(r.penalty).toBe(0);
  });
});

describe('simple-mode penalty math (default)', () => {
  it('₹10000 / 30 days / graceDays=7 / annual 18% → 23 chargeable days → 113.42', () => {
    const r = computeLatePenalty({
      invoiceAmount: 10000,
      dueDate: DUE_30_DAYS_AGO,
      status: 'Issued',
      asOf: ASOF,
    });
    expect(r.applies).toBe(true);
    expect(r.daysOverdue).toBe(30);
    expect(r.chargeableDays).toBe(23);
    expect(r.graceDays).toBe(7);
    expect(r.mode).toBe('simple');
    expect(r.ratePercent).toBe(18);
    // 10000 * 0.18 * 23 / 365 = 113.4246..., round2 → 113.42
    expect(r.penalty).toBe(113.42);
    expect(r.newBalance).toBe(10113.42);
    expect(r.reason).toBeNull();
  });

  it('status=Partial is payable (PAYABLE_STATUSES contract)', () => {
    const r = computeLatePenalty({
      invoiceAmount: 10000,
      dueDate: DUE_30_DAYS_AGO,
      status: 'Partial',
      asOf: ASOF,
    });
    expect(r.applies).toBe(true);
    expect(r.penalty).toBe(113.42);
  });

  it('mode=unknown falls back to simple', () => {
    const r = computeLatePenalty({
      invoiceAmount: 10000,
      dueDate: DUE_30_DAYS_AGO,
      status: 'Issued',
      asOf: ASOF,
      mode: 'unknown',
    });
    expect(r.mode).toBe('simple');
    expect(r.penalty).toBe(113.42);
  });
});

describe('flat-mode penalty math', () => {
  it('flat 2% on ₹10000, 30 days overdue → flat 200.00 regardless of days', () => {
    const r = computeLatePenalty({
      invoiceAmount: 10000,
      dueDate: DUE_30_DAYS_AGO,
      status: 'Issued',
      asOf: ASOF,
      mode: 'flat',
    });
    expect(r.applies).toBe(true);
    expect(r.mode).toBe('flat');
    expect(r.ratePercent).toBe(2);
    expect(r.penalty).toBe(200);
    expect(r.newBalance).toBe(10200);
  });

  it('flat mode: 60 days overdue yields same penalty as 30 days (rate is per-cycle, not per-day)', () => {
    const due60 = new Date('2026-03-02T00:00:00Z'); // 60 days before ASOF
    const r = computeLatePenalty({
      invoiceAmount: 10000,
      dueDate: due60,
      status: 'Issued',
      asOf: ASOF,
      mode: 'flat',
    });
    expect(r.daysOverdue).toBe(60);
    expect(r.penalty).toBe(200); // same as 30-days case above — flat fee is days-independent
  });
});

describe('half-up rounding boundary via Number.EPSILON nudge', () => {
  it('flat mode P=10, flatFeePercent=0.05 → 0.005 → rounds half-up to 0.01', () => {
    const r = computeLatePenalty({
      invoiceAmount: 10,
      dueDate: DUE_30_DAYS_AGO,
      status: 'Issued',
      asOf: ASOF,
      mode: 'flat',
      flatFeePercent: 0.05,
    });
    // 10 * 0.05/100 = 0.005 → round2(0.005 + EPS) = 0.01
    expect(r.penalty).toBe(0.01);
    expect(r.newBalance).toBe(10.01);
  });
});

describe('Decimal / string coercion of invoiceAmount', () => {
  it('invoiceAmount="10000" parses identically to numeric 10000', () => {
    const r = computeLatePenalty({
      invoiceAmount: '10000',
      dueDate: DUE_30_DAYS_AGO,
      status: 'Issued',
      asOf: ASOF,
    });
    expect(r.penalty).toBe(113.42);
    expect(r.newBalance).toBe(10113.42);
  });

  it('Decimal-like object with toString() coerces via Number()', () => {
    const decimalLike = { toString: () => '10000' };
    const r = computeLatePenalty({
      invoiceAmount: decimalLike,
      dueDate: DUE_30_DAYS_AGO,
      status: 'Issued',
      asOf: ASOF,
    });
    expect(r.penalty).toBe(113.42);
  });
});

describe('NaN-defensive principal', () => {
  it('invoiceAmount=NaN, chargeable window → ZERO_PRINCIPAL (treated as 0)', () => {
    const r = computeLatePenalty({
      invoiceAmount: NaN,
      dueDate: DUE_30_DAYS_AGO,
      status: 'Issued',
      asOf: ASOF,
    });
    // NaN → principal=0 → outside grace → ZERO_PRINCIPAL
    expect(r.reason).toBe('ZERO_PRINCIPAL');
    expect(r.penalty).toBe(0);
  });

  it('invoiceAmount="not-a-number", future dueDate → NOT_YET_DUE (date guard fires first)', () => {
    const futureDue = new Date('2026-06-01T00:00:00Z');
    const r = computeLatePenalty({
      invoiceAmount: 'not-a-number',
      dueDate: futureDue,
      status: 'Issued',
      asOf: ASOF,
    });
    expect(r.reason).toBe('NOT_YET_DUE');
    expect(r.penalty).toBe(0);
  });
});

describe('override propagation and clamping', () => {
  it('graceDays=0 override eliminates the grace window', () => {
    const due = new Date('2026-04-30T00:00:00Z'); // 1 day before ASOF
    const r = computeLatePenalty({
      invoiceAmount: 10000,
      dueDate: due,
      status: 'Issued',
      asOf: ASOF,
      graceDays: 0,
    });
    expect(r.graceDays).toBe(0);
    expect(r.daysOverdue).toBe(1);
    expect(r.chargeableDays).toBe(1);
    // 10000 * 0.18 * 1/365 = 4.9315..., round2 → 4.93
    expect(r.penalty).toBe(4.93);
  });

  it('annualRatePercent=12 override produces a smaller penalty than default 18%', () => {
    const r = computeLatePenalty({
      invoiceAmount: 10000,
      dueDate: DUE_30_DAYS_AGO,
      status: 'Issued',
      asOf: ASOF,
      annualRatePercent: 12,
    });
    expect(r.ratePercent).toBe(12);
    // 10000 * 0.12 * 23/365 = 75.6164..., round2 → 75.62
    expect(r.penalty).toBe(75.62);
  });

  it('flatFeePercent=5 override honored in flat mode', () => {
    const r = computeLatePenalty({
      invoiceAmount: 10000,
      dueDate: DUE_30_DAYS_AGO,
      status: 'Issued',
      asOf: ASOF,
      mode: 'flat',
      flatFeePercent: 5,
    });
    expect(r.ratePercent).toBe(5);
    expect(r.penalty).toBe(500);
  });

  it('negative graceDays clamped to 0', () => {
    const due = new Date('2026-04-30T00:00:00Z'); // 1 day before ASOF
    const r = computeLatePenalty({
      invoiceAmount: 10000,
      dueDate: due,
      status: 'Issued',
      asOf: ASOF,
      graceDays: -50,
    });
    expect(r.graceDays).toBe(0);
    expect(r.chargeableDays).toBe(1);
  });

  it('negative annualRatePercent clamped to 0 (penalty becomes 0 → reason ZERO_PRINCIPAL via penalty>0 gate)', () => {
    const r = computeLatePenalty({
      invoiceAmount: 10000,
      dueDate: DUE_30_DAYS_AGO,
      status: 'Issued',
      asOf: ASOF,
      annualRatePercent: -10,
    });
    expect(r.ratePercent).toBe(0);
    expect(r.penalty).toBe(0);
    expect(r.applies).toBe(false);
    // When penalty rounds to 0, the envelope sets reason='ZERO_PRINCIPAL'
    // (the only post-math non-null reason — see SUT line 198).
    expect(r.reason).toBe('ZERO_PRINCIPAL');
  });

  it('negative flatFeePercent clamped to 0 in flat mode', () => {
    const r = computeLatePenalty({
      invoiceAmount: 10000,
      dueDate: DUE_30_DAYS_AGO,
      status: 'Issued',
      asOf: ASOF,
      mode: 'flat',
      flatFeePercent: -5,
    });
    expect(r.ratePercent).toBe(0);
    expect(r.penalty).toBe(0);
  });
});

describe('whole-day floor for partial-day timestamps', () => {
  it('asOf 8.5 days after dueDate → daysOverdue=8 (floored, not rounded up to 9)', () => {
    const due = new Date('2026-04-22T12:00:00Z');
    const asOfPlus8h = new Date('2026-05-01T00:00:00Z'); // 8 days + 12 hours later
    const r = computeLatePenalty({
      invoiceAmount: 10000,
      dueDate: due,
      status: 'Issued',
      asOf: asOfPlus8h,
      graceDays: 0,
    });
    expect(r.daysOverdue).toBe(8);
    expect(r.chargeableDays).toBe(8);
  });
});
