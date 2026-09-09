import { describe, expect, it } from "vitest";
import {
  buildTallyMastersXml,
  buildTallyXml,
  buildVoucherRows,
} from "./tallyExportBuilder";

const master = {
  companyName: "Test Travel Company",
  from: "2026-09-07",
  to: "2026-09-07",
};

const makeRows = () => buildVoucherRows({
  accounts: [],
  commonRows: [],
  customers: [{
    reference: "INTERNAL-INVOICE-1",
    paymentReference: "REC-0002",
    name: "Customer One",
    invoiceTotal: 246750.90,
    amount: 246750.90,
    transactionDate: "2026-09-07",
    itineraryId: 1,
    gstRetrieved: true,
    gstAmount: 22431.90,
    tcsAmount: 0,
  }],
  payables: [
    ["Vendor One", 20000, "PAY-0004"],
    ["Vendor Two", 50000, "PAY-0006"],
    ["Vendor Three", 100000, "PAY-0008"],
  ].map(([name, amount, paymentReference], index) => ({
    reference: `INTERNAL-PAYABLE-${index + 1}`,
    name,
    amount,
    status: "paid",
    paidAt: "2026-09-07",
    paymentReference,
    itineraryId: 1,
  })),
  trips: [{ id: 1, destination: "Test Trip" }],
  tripTaxes: {},
  master,
  selectedSubBrandLabel: "Travel",
});

describe("Tally GST journal export", () => {
  it("posts Sales Ledger Dr to GST Payable Cr without bill allocation", () => {
    const rows = makeRows();
    const xml = buildTallyXml({ companyName: master.companyName, voucherRows: rows });
    const journal = xml.match(/<VOUCHER VCHTYPE="Journal"[\s\S]*?<\/VOUCHER>/)?.[0] || "";

    expect(journal).toContain("<LEDGERNAME>Sales Ledger</LEDGERNAME>");
    expect(journal).toContain("<AMOUNT>-22431.90</AMOUNT>");
    expect(journal).toContain("<LEDGERNAME>GST Payable</LEDGERNAME>");
    expect(journal).toContain("<AMOUNT>22431.90</AMOUNT>");
    expect(journal).not.toContain("BILLALLOCATIONS.LIST");
    expect(journal).not.toContain("<LEDGERNAME>Travel</LEDGERNAME>");
  });

  it("keeps exact generated settlement references and dates", () => {
    const rows = makeRows();
    const xml = buildTallyXml({ companyName: master.companyName, voucherRows: rows });
    expect((xml.match(/<BILLTYPE>Agst Ref<\/BILLTYPE>/g) || [])).toHaveLength(4);
    for (const reference of ["INTERNAL-INVOICE-1", "PUR-0003", "PUR-0005", "PUR-0007"]) {
      expect(xml).toContain(`<NAME>${reference}</NAME><BILLTYPE>Agst Ref</BILLTYPE>`);
    }
    expect(xml).toContain("<DATE>20260907</DATE>");
  });

  it("keeps GST Payable under Duties & Taxes and omits the Travel master", () => {
    const xml = buildTallyMastersXml({ companyName: master.companyName, voucherRows: makeRows() });
    expect(xml).toContain('<LEDGER NAME="GST Payable" ACTION="Create"><NAME>GST Payable</NAME><PARENT>Duties &amp; Taxes</PARENT><ISBILLWISEON>No</ISBILLWISEON>');
    expect(xml).not.toContain('<LEDGER NAME="Travel"');
  });

  it("preserves the educational date behavior and GST accounting", () => {
    const xml = buildTallyXml({ companyName: master.companyName, voucherRows: makeRows(), educationalMode: true });
    expect(xml).toContain("<DATE>20260901</DATE>");
    expect(xml).toContain("<LEDGERNAME>Sales Ledger</LEDGERNAME>");
    expect(xml).toContain("<LEDGERNAME>GST Payable</LEDGERNAME>");
  });

  it("alters existing paid Sales and Receipt vouchers", () => {
    const rows = makeRows();
    const xml = buildTallyXml({
      companyName: master.companyName,
      voucherRows: rows,
      alterExistingReceipts: true,
    });
    const receipt = xml.match(/<VOUCHER VCHTYPE="Receipt"[\s\S]*?<\/VOUCHER>/)?.[0] || "";
    const sales = xml.match(/<VOUCHER VCHTYPE="Sales"[\s\S]*?<\/VOUCHER>/)?.[0] || "";

    expect(receipt).toContain('ACTION="Alter"');
    expect(receipt).toContain('TAGNAME="Voucher Number" TAGVALUE="REC-INTERNAL-INVOICE-1"');
    expect(sales).toContain('ACTION="Alter"');
  });

  it("exports paid-only Sales and Receipt amounts", () => {
    const rows = buildVoucherRows({
      accounts: [],
      commonRows: [],
      customers: [{
        reference: "INV-PAID-1",
        paymentReference: "REC-PAID-1",
        name: "Customer One",
        invoiceTotal: 120000,
        amount: 40000,
        transactionDate: "2026-09-07",
        itineraryId: 1,
      }],
      payables: [],
      trips: [{ id: 1, destination: "Test Trip" }],
      tripTaxes: {},
      master,
      selectedSubBrandLabel: "Travel",
    });
    const xml = buildTallyXml({ companyName: master.companyName, voucherRows: rows });
    const sales = xml.match(/<VOUCHER VCHTYPE="Sales"[\s\S]*?<\/VOUCHER>/)?.[0] || "";
    const receipt = xml.match(/<VOUCHER VCHTYPE="Receipt"[\s\S]*?<\/VOUCHER>/)?.[0] || "";

    expect(sales).toContain("<AMOUNT>40000.00</AMOUNT>");
    expect(receipt).toContain("<AMOUNT>-40000.00</AMOUNT>");
    expect(receipt).toContain("<AMOUNT>40000.00</AMOUNT>");
  });

  it("rejects an Agst Ref with no exact New Ref", () => {
    const rows = makeRows();
    rows.find((row) => row[1] === "Receipt")[10] = "MISSING-BILL";
    expect(() => buildTallyXml({ companyName: master.companyName, voucherRows: rows })).toThrowError(
      expect.objectContaining({ code: "TALLY_BILL_NOT_FOUND" }),
    );
  });
});
