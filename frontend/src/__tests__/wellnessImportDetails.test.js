import { describe, expect, it } from "vitest";
import {
  getImportedInvoicePaymentBreakdown,
  getImportedVisitDetails,
} from "../utils/wellnessImportDetails";

describe("wellness import details", () => {
  it("reads source staff and service names from imported visit notes", () => {
    expect(getImportedVisitDetails({
      notes: JSON.stringify({
        sourceBookingId: "booking-1",
        source: {
          Staff: "Doctor A, Doctor B",
          "Items / Services": "Treatment A; Treatment B",
          "Booking Type": "Home / Online",
          "Booking Notes": "Follow up after treatment",
          "Void / Cancel Reason": "Patient rescheduled",
        },
      }),
    })).toEqual({
      staff: "Doctor A, Doctor B",
      services: "Treatment A; Treatment B",
      bookingType: "Home / Online",
      bookingNotes: "Follow up after treatment",
      cancelReason: "Patient rescheduled",
    });
  });

  it("ignores non-imported or malformed visit notes", () => {
    expect(getImportedVisitDetails({ notes: "staff note" })).toBeNull();
    expect(getImportedVisitDetails({ notes: JSON.stringify({ source: {} }) })).toBeNull();
  });

  it("returns only positive payment source amounts from imported invoices", () => {
    expect(getImportedInvoicePaymentBreakdown({
      amountPaid: 1700.5,
      lineItemsJson: JSON.stringify({
        source: { Cash: "1,200", UPI: "500.50", Card: "0" },
      }),
    })).toEqual([
      { mode: "Cash", amount: 1200 },
      { mode: "UPI", amount: 500.5 },
    ]);
  });

  it("hides source payment splits that do not match the invoice's collected amount", () => {
    expect(getImportedInvoicePaymentBreakdown({
      amountPaid: 1000,
      balance: 700,
      lineItemsJson: JSON.stringify({
        source: { Cash: "1,200", UPI: "500.50" },
      }),
    })).toEqual([]);
  });

  it("returns no payment source details for malformed or unrelated invoice data", () => {
    expect(getImportedInvoicePaymentBreakdown({ lineItemsJson: "not-json" })).toEqual([]);
    expect(getImportedInvoicePaymentBreakdown({ lineItemsJson: "[]" })).toEqual([]);
  });
});
