const { parseZyluInvoicePaymentBreakdown } = require("../../lib/zyluImportMappings");

describe("Zylu invoice payment mapping", () => {
  it("maps positive source payment amounts to CRM payment modes", () => {
    const breakdown = parseZyluInvoicePaymentBreakdown(JSON.stringify({
      source: {
        Cash: "1,200",
        UPI: "500.50",
        Card: "0",
        "Wallet Redemption": "30",
      },
    }));

    expect(breakdown).toEqual([
      { mode: "cash", amount: 1200 },
      { mode: "upi", amount: 500.5 },
      { mode: "wallet_redemption", amount: 30 },
    ]);
  });

  it("returns no source breakdown for invalid or unrelated JSON", () => {
    expect(parseZyluInvoicePaymentBreakdown("not-json")).toEqual([]);
    expect(parseZyluInvoicePaymentBreakdown(JSON.stringify({ services: "Laser" }))).toEqual([]);
  });
});
