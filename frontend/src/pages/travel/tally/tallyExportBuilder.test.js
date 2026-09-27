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
    expect(journal).toContain("<REFERENCE>SALES-LEDGER-1</REFERENCE>");
    expect(journal).not.toContain("BILLALLOCATIONS.LIST");
    expect(journal).not.toContain("<LEDGERNAME>Travel</LEDGERNAME>");
  });

  it("keeps exact stable settlement references and dates", () => {
    const rows = makeRows();
    const xml = buildTallyXml({ companyName: master.companyName, voucherRows: rows });
    expect((xml.match(/<BILLTYPE>Agst Ref<\/BILLTYPE>/g) || [])).toHaveLength(4);
    for (const reference of ["INTERNAL-INVOICE-1", "INTERNAL-PAYABLE-1", "INTERNAL-PAYABLE-2", "INTERNAL-PAYABLE-3"]) {
      expect(xml).toContain(`<NAME>${reference}</NAME><BILLTYPE>Agst Ref</BILLTYPE>`);
    }
    expect(xml).toContain("<DATE>20260907</DATE>");
  });

  it("keeps GST Payable under Duties & Taxes and omits the Travel master", () => {
    const xml = buildTallyMastersXml({ companyName: master.companyName, voucherRows: makeRows() });
    expect(xml).toContain('<LEDGER NAME="GST Payable" ACTION="Create"><NAME>GST Payable</NAME><PARENT>Duties &amp; Taxes</PARENT><ISBILLWISEON>No</ISBILLWISEON>');
    expect(xml).not.toContain('<LEDGER NAME="Travel"');
  });

  it("creates one trip cost centre master and enables it on posting ledgers", () => {
    const xml = buildTallyMastersXml({ companyName: master.companyName, voucherRows: makeRows() });
    expect(xml).toContain('<COSTCENTRE NAME="TRIP-1" ACTION="Create">');
    expect(xml.match(/<COSTCENTRE NAME="TRIP-1"/g)).toHaveLength(1);
    expect(xml).toContain("<ISCOSTCENTRESON>Yes</ISCOSTCENTRESON>");
    expect(xml).not.toContain('<LEDGER NAME="TRIP-1"');
  });

  it("allocates sales and purchases to the trip without double-counting settlements", () => {
    const xml = buildTallyXml({ companyName: master.companyName, voucherRows: makeRows() });
    const sales = xml.match(/<VOUCHER VCHTYPE="Sales"[\s\S]*?<\/VOUCHER>/)?.[0] || "";
    const purchase = xml.match(/<VOUCHER VCHTYPE="Purchase"[\s\S]*?<\/VOUCHER>/)?.[0] || "";
    const receipt = xml.match(/<VOUCHER VCHTYPE="Receipt"[\s\S]*?<\/VOUCHER>/)?.[0] || "";
    const payment = xml.match(/<VOUCHER VCHTYPE="Payment"[\s\S]*?<\/VOUCHER>/)?.[0] || "";

    for (const voucher of [sales, purchase]) {
      expect(voucher).toContain("<CATEGORYALLOCATIONS.LIST>");
      expect(voucher).toContain("<NAME>TRIP-1</NAME>");
    }
    expect(receipt).not.toContain("COSTCENTREALLOCATIONS.LIST");
    expect(payment).not.toContain("COSTCENTREALLOCATIONS.LIST");
  });

  it("uses first-of-month dates in Educational Mode and preserves GST accounting", () => {
    const xml = buildTallyXml({ companyName: master.companyName, voucherRows: makeRows(), educationalMode: true });
    expect(xml).toContain("<DATE>20260901</DATE>");
    expect(xml).toContain("Original transaction date: 2026-09-07");
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

  it("exports the full Sales invoice and only the received amount as Receipt", () => {
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

    expect(sales).toContain("<AMOUNT>120000.00</AMOUNT>");
    expect(receipt).toContain("<AMOUNT>-40000.00</AMOUNT>");
    expect(receipt).toContain("<AMOUNT>40000.00</AMOUNT>");
  });

  it("allocates trip operating expenses to the same cost centre", () => {
    const rows = buildVoucherRows({
      accounts: [],
      commonRows: [{ reference: "EXP-1", amount: 2500, transactionDate: "2026-09-15", itineraryId: 1, name: "Hotel expense" }],
      customers: [],
      payables: [],
      trips: [],
      tripTaxes: {},
      master,
      selectedSubBrandLabel: "Travel",
    });
    const xml = buildTallyXml({ companyName: master.companyName, voucherRows: rows });
    const expense = xml.match(/<VOUCHER VCHTYPE="Payment"[\s\S]*?<\/VOUCHER>/)?.[0] || "";

    expect(expense).toContain("<DATE>20260915</DATE>");
    expect(expense).toContain("<CATEGORYALLOCATIONS.LIST>");
    expect(expense).toContain("<NAME>TRIP-1</NAME>");
  });

  it("uses a payable transaction date instead of its due date", () => {
    const rows = buildVoucherRows({
      accounts: [],
      commonRows: [],
      customers: [],
      payables: [{ reference: "PUR-1", name: "Supplier", amount: 5000, transactionDate: "2026-09-15", dueDate: "2026-10-01", itineraryId: 1 }],
      trips: [],
      tripTaxes: {},
      master,
      selectedSubBrandLabel: "Travel",
    });
    const xml = buildTallyXml({ companyName: master.companyName, voucherRows: rows });
    const purchase = xml.match(/<VOUCHER VCHTYPE="Purchase"[\s\S]*?<\/VOUCHER>/)?.[0] || "";

    expect(purchase).toContain("<DATE>20260915</DATE>");
    expect(purchase).not.toContain("<DATE>20261001</DATE>");
  });

  it("rejects an Agst Ref with no exact New Ref", () => {
    const rows = makeRows();
    rows.find((row) => row[1] === "Receipt")[10] = "MISSING-BILL";
    expect(() => buildTallyXml({ companyName: master.companyName, voucherRows: rows })).toThrowError(
      expect.objectContaining({ code: "TALLY_BILL_NOT_FOUND" }),
    );
  });
});
