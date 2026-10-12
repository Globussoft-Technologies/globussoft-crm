import { describe, test, expect } from 'vitest';
import { createRequire } from 'node:module';
const { travelInvoiceReceiptTotal: total } = createRequire(import.meta.url)('../../lib/travelInvoiceReceiptTotal');

describe('travel invoice receipt reconciliation', () => {
  test('adds independent schedule and manual receipts', () => {
    expect(total([{ id: 1, receivedAmount: 200 }], [{ id: 2, amount: 300 }])).toBe(500);
  });
  test('does not count an explicitly linked milestone twice', () => {
    expect(total([{ id: 1, receivedAmount: 200 }], [{ id: 2, amount: 200, receiptMetadata: { scheduleId: 1 } }])).toBe(200);
  });
  test('whole-invoice gateway receipts overlap allocated schedules but manual receipts do not', () => {
    expect(total([{ id: 1, receivedAmount: 200 }], [
      { id: 2, amount: 200, receiptMetadata: { kind: 'travel-invoice' } }, { id: 3, amount: 100 },
    ])).toBe(300);
  });
  test('installment receipts do not discard separate manual payments', () => {
    expect(total([], [{ id: 2, amount: 100 }], [{ id: 3, paidAmount: 200 }])).toBe(300);
    expect(total([], [{ id: 2, amount: 200, receiptMetadata: { tripInstalmentPaymentId: 3 } }], [{ id: 3, paidAmount: 200 }])).toBe(200);
  });
  test('uses integer cents and counts each Payment ID once', () => {
    expect(total([], [{ id: 2, amount: 0.1 }, { id: 3, amount: 0.2 }, { id: 2, amount: 0.1 }])).toBe(0.3);
  });
});
