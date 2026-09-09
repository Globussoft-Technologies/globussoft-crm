import { describe, expect, it } from "vitest";
import { getTripLedgerRows } from "./tallyMath";

describe("Tally voucher summary profit/loss", () => {
  it("deducts GST once from cash and accrual profit", () => {
    const [summary] = getTripLedgerRows({
      trips: [{ id: 1, destination: "Singapore" }],
      customers: [{
        itineraryId: 1,
        invoiceTotal: 269052,
        amount: 134526,
        gstRetrieved: true,
        gstAmount: 14413.5,
        tcsAmount: 0,
      }],
      payables: [],
      suppliers: [],
      tripTaxes: {},
    });

    expect(summary.sales).toBe(134526);
    expect(summary.unpaidSales).toBe(134526);
    expect(summary.purchase).toBe(0);
    expect(summary.cashProfit).toBe(120112.5);
    expect(summary.accrualProfit).toBe(254638.5);
  });
});
