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

  it("returns only positive payment amounts from the separate imported split field", () => {
    expect(getImportedInvoicePaymentBreakdown({
      amountPaid: 1700.5,
      importedPaymentSplit: { Cash: "1,200", UPI: "500.50", Card: "0" },
    })).toEqual([
      { mode: "Cash", amount: 1200 },
      { mode: "UPI", amount: 500.5 },
    ]);
  });

  it("hides source payment splits that do not match the invoice's collected amount", () => {
    expect(getImportedInvoicePaymentBreakdown({
      amountPaid: 1000,
      balance: 700,
      importedPaymentSplit: { Cash: "1,200", UPI: "500.50" },
    })).toEqual([]);
  });

  it("does not repeat a single payment method as a split", () => {
    expect(getImportedInvoicePaymentBreakdown({
      amountPaid: 7350,
      importedPaymentSplit: { Cash: 7350, UPI: 0 },
    })).toEqual([]);
  });

  it("allows a one-paisa tolerance and ignores overwritten line-item JSON", () => {
    expect(getImportedInvoicePaymentBreakdown({
      amountPaid: 6275.01,
      importedPaymentSplit: { Cash: 6200, UPI: 75 },
      lineItemsJson: JSON.stringify([{ name: "Dr Consultation", amount: 6275 }]),
    })).toEqual([
      { mode: "Cash", amount: 6200 },
      { mode: "UPI", amount: 75 },
    ]);
    expect(getImportedInvoicePaymentBreakdown({
      amountPaid: 6275.02,
      importedPaymentSplit: { Cash: 6200, UPI: 75 },
    })).toEqual([]);
    expect(getImportedInvoicePaymentBreakdown({
      amountPaid: 6275,
      lineItemsJson: JSON.stringify({ source: { Cash: 6200, UPI: 75 } }),
    })).toEqual([]);
    expect(getImportedInvoicePaymentBreakdown({ importedPaymentSplit: "not-json" })).toEqual([]);
  });
});
