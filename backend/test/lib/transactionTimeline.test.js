/**
 * Unit tests for backend/lib/transactionTimeline.js — the pure builder behind
 * GET /api/wellness/my-transactions.
 *
 * Focus: the gift-card expense/credit contract that was buggy before this
 * helper existed (a gift-card buy showed Total Paid ₹0 + a phantom "+price"
 * redeemed row). These pin:
 *   - a gift-card PURCHASE surfaces as a "Gift card purchase" DEBIT and lands
 *     in onlineTotal → totalPaid;
 *   - the matching wallet CREDIT shows separately and is NOT in totalPaid;
 *   - a REDEEMED gift card is suppressed (no third "+price" line);
 *   - an OUTSTANDING gift card shows as an informational pending credit;
 *   - selectGiftCardPayments scopes by buyer/recipient + confirmed status;
 *   - the totalPaid identity + POS / subscription / wallet-topup math.
 */
import { describe, it, expect } from 'vitest';
import {
  buildTransactionTimeline,
  selectGiftCardPayments,
} from '../../lib/transactionTimeline.js';

const PATIENT = { id: 7, userId: 42 };

const gcPayment = (over = {}) => ({
  id: 1,
  status: 'SUCCESS',
  amount: 100,
  gateway: 'razorpay',
  gatewayId: 'pay_abc',
  paidAt: '2026-06-02T10:00:00.000Z',
  createdAt: '2026-06-02T09:59:00.000Z',
  metadata: JSON.stringify({
    kind: 'giftcard_purchase',
    giftCardId: 9,
    patientId: 7,
    buyerUserId: 42,
  }),
  ...over,
});

describe('selectGiftCardPayments', () => {
  it('keeps a confirmed gift-card purchase matched by buyerUserId', () => {
    const out = selectGiftCardPayments([gcPayment()], PATIENT);
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe('giftcard_purchase');
    expect(out[0].invoiceNum).toBeNull();
  });

  it('keeps a purchase matched by recipient patientId even if buyer differs', () => {
    const p = gcPayment({
      metadata: JSON.stringify({ kind: 'giftcard_purchase', patientId: 7, buyerUserId: 999 }),
    });
    expect(selectGiftCardPayments([p], PATIENT)).toHaveLength(1);
  });

  it('drops payments for a different patient/buyer', () => {
    const p = gcPayment({
      metadata: JSON.stringify({ kind: 'giftcard_purchase', patientId: 8, buyerUserId: 99 }),
    });
    expect(selectGiftCardPayments([p], PATIENT)).toHaveLength(0);
  });

  it('drops non-giftcard-purchase kinds', () => {
    const p = gcPayment({ metadata: JSON.stringify({ kind: 'invoice', patientId: 7 }) });
    expect(selectGiftCardPayments([p], PATIENT)).toHaveLength(0);
  });

  it('drops abandoned PENDING / FAILED orders (only SUCCESS + REFUNDED surface)', () => {
    expect(selectGiftCardPayments([gcPayment({ status: 'PENDING' })], PATIENT)).toHaveLength(0);
    expect(selectGiftCardPayments([gcPayment({ status: 'FAILED' })], PATIENT)).toHaveLength(0);
    expect(selectGiftCardPayments([gcPayment({ status: 'REFUNDED' })], PATIENT)).toHaveLength(1);
  });

  it('tolerates malformed / missing metadata without throwing', () => {
    expect(selectGiftCardPayments([gcPayment({ metadata: 'not-json' })], PATIENT)).toHaveLength(0);
    expect(selectGiftCardPayments([gcPayment({ metadata: null })], PATIENT)).toHaveLength(0);
  });
});

describe('buildTransactionTimeline — gift-card buy expense/credit', () => {
  it('the reported scenario: paid ₹100, wallet +₹150, redeemed card suppressed', () => {
    const { transactions, summary } = buildTransactionTimeline({
      patient: PATIENT,
      walletBalance: 150,
      giftCardPaymentRows: [gcPayment()], // ₹100 paid via Razorpay
      walletTxns: [
        {
          id: 5,
          type: 'GIFTCARD_REDEEM',
          amount: 150, // gift value credited to wallet
          reason: 'Gift card Summer sale purchased',
          balanceAfter: 150,
          createdAt: '2026-06-02T10:01:00.000Z',
        },
      ],
      giftCards: [
        {
          id: 9,
          name: 'Summer sale',
          code: 'XXXX',
          amount: 150,
          price: 100,
          status: 'redeemed',
          redeemedBy: 7, // redeemed by this patient → must be suppressed
          redeemedAt: '2026-06-02T10:01:00.000Z',
          createdAt: '2026-06-02T09:58:00.000Z',
        },
      ],
    });

    // Total Paid reflects the ₹100 spent (NOT ₹0, NOT inflated by the credit).
    expect(summary.totalPaid).toBe(100);
    expect(summary.onlineTotal).toBe(100);
    expect(summary.walletBalance).toBe(150);
    expect(summary.walletTopUps).toBe(0); // a redeem, not a top-up
    expect(summary.transactionCount).toBe(2);

    const byId = Object.fromEntries(transactions.map((t) => [t.id, t]));
    // Expense row.
    expect(byId['payment-1']).toMatchObject({
      category: 'Gift Card',
      title: 'Gift card purchase',
      amount: 100,
      direction: 'debit',
    });
    // Credit row.
    expect(byId['wallet-5']).toMatchObject({
      category: 'Wallet',
      amount: 150,
      direction: 'credit',
    });
    // No phantom redeemed-card row.
    expect(byId['giftcard-9']).toBeUndefined();
  });

  it('an OUTSTANDING (un-redeemed) gift card shows as a pending credit, not counted in totals', () => {
    const { transactions, summary } = buildTransactionTimeline({
      patient: PATIENT,
      giftCards: [
        {
          id: 11,
          name: 'Welcome',
          code: 'AB12',
          amount: 500,
          status: 'active',
          redeemedBy: null,
          createdAt: '2026-05-01T00:00:00.000Z',
        },
      ],
    });
    const row = transactions.find((t) => t.id === 'giftcard-11');
    expect(row).toMatchObject({ category: 'Gift Card', direction: 'credit', amount: 500 });
    // Gift cards never feed totalPaid.
    expect(summary.totalPaid).toBe(0);
  });
});

describe('buildTransactionTimeline — summary math', () => {
  it('POS: completed sales add, refunds subtract (posTotal)', () => {
    const { summary } = buildTransactionTimeline({
      patient: PATIENT,
      sales: [
        { id: 1, invoiceNumber: 'INV1', total: 300, status: 'COMPLETED', createdAt: '2026-06-01T00:00:00Z', lineItems: [] },
        { id: 2, invoiceNumber: 'INV2', total: 50, status: 'REFUNDED', createdAt: '2026-06-02T00:00:00Z', lineItems: [] },
      ],
    });
    expect(summary.posTotal).toBe(250);
    expect(summary.totalPaid).toBe(250);
  });

  it('subscriptions add to subscriptionsTotal but exclude CANCELLED', () => {
    const { summary } = buildTransactionTimeline({
      patient: PATIENT,
      subscriptions: [
        { id: 1, planName: 'Pro', amount: 999, status: 'ACTIVE', startDate: '2026-01-01T00:00:00Z' },
        { id: 2, planName: 'Old', amount: 500, status: 'CANCELLED', startDate: '2026-02-01T00:00:00Z' },
      ],
    });
    expect(summary.subscriptionsTotal).toBe(999);
    expect(summary.totalPaid).toBe(999);
  });

  it('wallet TOP_UP feeds walletTopUps, NOT totalPaid', () => {
    const { summary } = buildTransactionTimeline({
      patient: PATIENT,
      walletBalance: 2000,
      walletTxns: [
        { id: 1, type: 'TOP_UP', amount: 2000, balanceAfter: 2000, createdAt: '2026-06-01T00:00:00Z' },
      ],
    });
    expect(summary.walletTopUps).toBe(2000);
    expect(summary.totalPaid).toBe(0);
  });

  it('totalPaid === posTotal + onlineTotal + subscriptionsTotal (identity)', () => {
    const { summary } = buildTransactionTimeline({
      patient: PATIENT,
      sales: [{ id: 1, invoiceNumber: 'INV1', total: 300, status: 'COMPLETED', createdAt: '2026-06-01T00:00:00Z', lineItems: [] }],
      giftCardPaymentRows: [gcPayment()],
      subscriptions: [{ id: 1, planName: 'Pro', amount: 100, status: 'ACTIVE', startDate: '2026-01-01T00:00:00Z' }],
    });
    expect(summary.totalPaid).toBeCloseTo(
      summary.posTotal + summary.onlineTotal + summary.subscriptionsTotal,
      5,
    );
    expect(summary.totalPaid).toBe(500); // 300 + 100 + 100
  });

  it('orders the timeline newest-first', () => {
    const { transactions } = buildTransactionTimeline({
      patient: PATIENT,
      sales: [
        { id: 1, invoiceNumber: 'OLD', total: 1, status: 'COMPLETED', createdAt: '2026-01-01T00:00:00Z', lineItems: [] },
        { id: 2, invoiceNumber: 'NEW', total: 1, status: 'COMPLETED', createdAt: '2026-12-01T00:00:00Z', lineItems: [] },
      ],
    });
    expect(transactions[0].id).toBe('sale-2');
    expect(transactions[1].id).toBe('sale-1');
  });
});
