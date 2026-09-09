import { getInvoiceAmount, getTripLedgerRows, toTallyAmount } from "./tallyMath";

const dateOnly = (value) => {
  if (!value) return "";
  const raw = String(value).trim();
  const dayFirst = raw.match(/^(\d{2})[-/](\d{2})[-/](\d{4})/);
  if (dayFirst) {
    const candidate = `${dayFirst[3]}-${dayFirst[2]}-${dayFirst[1]}`;
    return isValidIsoDate(candidate) ? candidate : "";
  }
  const yearFirst = raw.match(/^(\d{4})[-/](\d{2})[-/](\d{2})/);
  if (yearFirst) {
    const candidate = `${yearFirst[1]}-${yearFirst[2]}-${yearFirst[3]}`;
    return isValidIsoDate(candidate) ? candidate : "";
  }
  return "";
};
const isValidIsoDate = (value) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
};
const accountAmount = (accounts, id) =>
  toTallyAmount(accounts.find((account) => account.id === id)?.amount);
const csvCell = (value) => `"${String(value ?? "").replace(/"/g, '""')}"`;
const xmlCell = (value) =>
  String(value ?? "").replace(
    /[&<>"]/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[character],
  );
const getVoucherDefinition = (voucherTypes = [], id, fallbackLabel) =>
  voucherTypes.find((voucher) => voucher.id === id) || {
    label: ({ sales: "Sales", receipt: "Receipt", purchase: "Purchase", payment: "Payment", taxJournal: "Journal" }[fallbackLabel] || fallbackLabel),
    prefix: ({ sales: "SAL", receipt: "REC", purchase: "PUR", payment: "PAY", taxJournal: "JRN" }[fallbackLabel] || fallbackLabel.slice(0, 4).toUpperCase()),
    narrationTemplate: ({ sales: "Sales", receipt: "Receipt", purchase: "Purchase", payment: "Payment", taxJournal: "Journal" }[fallbackLabel] || fallbackLabel),
    enabled: true,
    numberingMode: "auto",
  };
export const getVoucherNumberPreview = (voucher, sampleReference = "MANUAL-001") => {
  if (voucher.numberingMode === "manual") return sampleReference;
  if (voucher.numberingMode === "auto-manual") {
    return `${voucher.prefix || "TRV"}-0001 or ${sampleReference}`;
  }
  return `${voucher.prefix || "TRV"}-0001`;
};
const buildVoucherReference = ({ voucher, reference, index, useReference = false }) => {
  if (useReference && reference) return reference;
  if (reference && voucher.numberingMode !== "auto") return reference;
  if (reference && voucher.numberingMode === "auto-manual") return reference;
  return `${voucher.prefix || "TRV"}-${String(index + 1).padStart(4, "0")}`;
};

export const buildBaseFileName = (master) => {
  const company = (master.companyName || "travel-tally")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  const period = [master.from, master.to].filter(Boolean).join("_");
  return `${company || "travel-tally"}${period ? `_${period}` : ""}`;
};

export const buildCsv = (rows) =>
  rows.map((row) => row.map(csvCell).join(",")).join("\n");

const tallyDate = (value) => dateOnly(value).replace(/-/g, "");
const ledgerEntryXml = ({ ledger, amount, isParty = false, billReference = "", billType = "On Account" }) => {
  const isDebit = amount < 0;
  const billAllocation = isParty
    ? `<BILLALLOCATIONS.LIST><NAME>${xmlCell(billReference || "On Account")}</NAME><BILLTYPE>${billType}</BILLTYPE><AMOUNT>${amount.toFixed(2)}</AMOUNT></BILLALLOCATIONS.LIST>`
    : "";

  return `<LEDGERENTRIES.LIST><LEDGERNAME>${xmlCell(ledger)}</LEDGERNAME><ISDEEMEDPOSITIVE>${isDebit ? "Yes" : "No"}</ISDEEMEDPOSITIVE><ISPARTYLEDGER>${isParty ? "Yes" : "No"}</ISPARTYLEDGER><ISLASTDEEMEDPOSITIVE>${isDebit ? "Yes" : "No"}</ISLASTDEEMEDPOSITIVE><AMOUNT>${amount.toFixed(2)}</AMOUNT>${billAllocation}</LEDGERENTRIES.LIST>`;
};

const masterLedgerXml = ({ name, parent, billWise = false }) =>
  `<TALLYMESSAGE xmlns:UDF="TallyUDF"><LEDGER NAME="${xmlCell(name)}" ACTION="Create"><NAME>${xmlCell(name)}</NAME><PARENT>${xmlCell(parent)}</PARENT><ISBILLWISEON>${billWise ? "Yes" : "No"}</ISBILLWISEON></LEDGER></TALLYMESSAGE>`;

const masterVoucherTypeXml = (name) => {
  const parent = ({ Sales: "Sales", Receipt: "Receipt", Purchase: "Purchase", Payment: "Payment", Journal: "Journal" }[name] || "Journal");
  return `<TALLYMESSAGE xmlns:UDF="TallyUDF"><VOUCHERTYPE NAME="${xmlCell(name)}" ACTION="Create"><NAME>${xmlCell(name)}</NAME><PARENT>${xmlCell(parent)}</PARENT><NUMBERINGMETHOD>Manual</NUMBERINGMETHOD><ISOPTIONAL>No</ISOPTIONAL></VOUCHERTYPE></TALLYMESSAGE>`;
};

const voucherRowToXml = (row, index, { educationalMode = false, alterExistingReceipts = false } = {}) => {
  const [
    date,
    voucherType,
    ledger,
    party,
    trip,
    reference,
    debit,
    credit,
    narration,
    sourceTag,
    billReference,
  ] = row;
  const debitAmount = toTallyAmount(debit);
  const creditAmount = toTallyAmount(credit);
  const amount = debitAmount || creditAmount;
  const primaryAmount = debitAmount ? -amount : amount;
  const counterLedger = party || "Bank Ledger";
  const voucherNumber = reference || `TRAVEL-${index + 1}`;
  const originalDate = dateOnly(date);
  const educationalDate = originalDate ? `${originalDate.slice(0, 8)}01` : "";
  const dateNote = educationalMode && originalDate && !originalDate.endsWith("-01")
    ? ` | Original transaction date: ${originalDate}`
    : "";
  const fullNarration = `${narration}${trip ? ` | ${trip}` : ""}${dateNote}`;
  const billType = voucherType === "Sales" || voucherType === "Purchase"
    ? "New Ref"
    : billReference
      ? "Agst Ref"
      : "On Account";
  if (voucherType === "Receipt" || voucherType === "Payment") {
    console.debug("[tally-export] bill link", {
      voucherType,
      voucherNumber,
      party: counterLedger,
      sourceReference: reference,
      billReference: billReference || null,
      billType,
    });
  }

  const safeDate = educationalMode
    ? tallyDate(educationalDate || `${dateOnly(new Date().toISOString()).slice(0, 8)}01`)
    : tallyDate(date) || tallyDate(new Date().toISOString());
  const counterIsParty = voucherType !== "Journal";
  const shouldAlter = alterExistingReceipts && (voucherType === "Sales" || voucherType === "Receipt");
  const actionAttributes = shouldAlter
    ? ` DATE="${xmlCell(originalDate || dateOnly(new Date().toISOString()))}" TAGNAME="Voucher Number" TAGVALUE="${xmlCell(voucherNumber)}" ACTION="Alter"`
    : ` DATE="${safeDate}" ACTION="Create"`;
  return `<TALLYMESSAGE xmlns:UDF="TallyUDF"><VOUCHER VCHTYPE="${xmlCell(voucherType)}"${actionAttributes} OBJVIEW="Accounting Voucher View"><DATE>${safeDate}</DATE><VOUCHERTYPENAME>${xmlCell(voucherType)}</VOUCHERTYPENAME><VOUCHERNUMBER>${xmlCell(voucherNumber)}</VOUCHERNUMBER><PERSISTEDVIEW>Accounting Voucher View</PERSISTEDVIEW><ISINVOICE>No</ISINVOICE><REFERENCE>${xmlCell(reference)}</REFERENCE><NARRATION>${xmlCell(fullNarration)}</NARRATION>${ledgerEntryXml({ ledger, amount: primaryAmount })}${ledgerEntryXml({ ledger: counterLedger, amount: -primaryAmount, isParty: counterIsParty, billReference: billReference || (voucherType === "Sales" || voucherType === "Purchase" ? voucherNumber : ""), billType })}</VOUCHER></TALLYMESSAGE>`;
};

export const buildTallyXml = ({ companyName, voucherRows, educationalMode = false, alterExistingReceipts = false }) => {
  validateBillAllocations({ voucherRows });
  const voucherXml = voucherRows.slice(1).map((row, index) => voucherRowToXml(row, index, { educationalMode, alterExistingReceipts })).join("");
  return `<?xml version="1.0" encoding="UTF-8"?><ENVELOPE><HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER><BODY><IMPORTDATA><REQUESTDESC><REPORTNAME>Vouchers</REPORTNAME><STATICVARIABLES><SVCURRENTCOMPANY>${xmlCell(companyName || "")}</SVCURRENTCOMPANY></STATICVARIABLES></REQUESTDESC><REQUESTDATA>${voucherXml}</REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>`;
};

export const validateBillAllocations = ({ voucherRows = [] }) => {
  const billNames = new Set(
    voucherRows
      .slice(1)
      .filter((row) => row[1] === "Sales" || row[1] === "Purchase")
      .map((row) => String(row[5] || "").trim())
      .filter(Boolean),
  );
  voucherRows.slice(1).forEach((row) => {
    const voucherType = row[1];
    const billType = voucherType === "Receipt" || voucherType === "Payment" ? (row[10] ? "Agst Ref" : "On Account") : "New Ref";
    const billName = String(row[10] || "").trim();
    if (billType === "Agst Ref" && !billNames.has(billName)) {
      const error = new Error(`No exact New Ref bill exists for ${voucherType} ${row[5] || "(unnumbered)"}: ${billName}`);
      error.code = "TALLY_BILL_NOT_FOUND";
      throw error;
    }
  });
  return true;
};

export const buildTallyMastersXml = ({ companyName, voucherRows }) => {
  const rows = voucherRows.slice(1);
  const ledgerParents = new Map();
  rows.forEach((row) => {
    const source = String(row[9] || "").toLowerCase();
    if (row[2]) ledgerParents.set(row[2], null);
    if (row[3]) {
      if (source.includes("supplier")) ledgerParents.set(row[3], "Sundry Creditors");
      else if (source.includes("customer")) ledgerParents.set(row[3], "Sundry Debtors");
      else if (!ledgerParents.has(row[3])) ledgerParents.set(row[3], null);
    }
  });
  const ledgerXml = [...ledgerParents.keys()].map((name) => {
    const normalized = String(name).toLowerCase();
    const parent = ledgerParents.get(name) || (normalized.includes("cash") || normalized.includes("bank")
      ? "Cash-in-Hand"
      : normalized.includes("gst") || normalized.includes("tcs") || normalized.includes("tax")
        ? "Duties & Taxes"
        : normalized.includes("purchase") || normalized.includes("expense")
          ? "Purchase Accounts"
          : "Sales Accounts");
    return masterLedgerXml({ name, parent, billWise: Boolean(ledgerParents.get(name)) });
  }).join("");
  const builtInVoucherTypes = new Set(["Sales", "Receipt", "Purchase", "Payment", "Journal", "Credit Note", "Debit Note"]);
  const voucherTypeXml = [...new Set(rows.map((row) => row[1]).filter((name) => name && !builtInVoucherTypes.has(name)))].map(masterVoucherTypeXml).join("");
  return `<?xml version="1.0" encoding="UTF-8"?><ENVELOPE><HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER><BODY><IMPORTDATA><REQUESTDESC><REPORTNAME>All Masters</REPORTNAME><STATICVARIABLES><SVCURRENTCOMPANY>${xmlCell(companyName || "")}</SVCURRENTCOMPANY><IMPORTDUPS>@@DUPMODIFY</IMPORTDUPS></STATICVARIABLES></REQUESTDESC><REQUESTDATA>${ledgerXml}${voucherTypeXml}</REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>`;
};

const createLedgerResolver = ({ ledgerRows = [], ledgerMappings = [] }) => {
  const ledgerNameById = Object.fromEntries(
    ledgerRows.map((ledger) => [ledger.id, ledger.name]),
  );
  const mappedLedgerIdByType = Object.fromEntries(
    ledgerMappings.map((mapping) => [mapping.id, mapping.ledgerId]),
  );

  return (mappingId, fallback) =>
    ledgerNameById[mappedLedgerIdByType[mappingId]] || fallback;
};

export const validateExport = ({ master, voucherRows }) => {
  const warnings = [];

  if (!String(master.companyName || "").trim()) {
    warnings.push("Company name is missing.");
  }
  if (!master.from || !master.to) {
    warnings.push("Transaction date range is incomplete.");
  }
  if (voucherRows.length <= 1) {
    warnings.push("No voucher rows are available for export.");
  }

  const dataRows = voucherRows.slice(1);
  let missingDateCount = 0;
  let missingLedgerCount = 0;
  let missingPartyCount = 0;
  let invalidAmountCount = 0;
  let invalidTypeCount = 0;
  let unbalancedRows = 0;

  dataRows.forEach((row) => {
    const [date, voucherType, ledger, party, , , debit, credit] = row;
    const debitAmount = toTallyAmount(debit);
    const creditAmount = toTallyAmount(credit);
    const hasDebit = debit !== "" && debit != null;
    const hasCredit = credit !== "" && credit != null;

    if (!String(date || "").trim()) missingDateCount += 1;
    if (!String(voucherType || "").trim()) invalidTypeCount += 1;
    if (!String(ledger || "").trim()) missingLedgerCount += 1;
    if (!String(party || "").trim()) missingPartyCount += 1;

    const invalidDebit = hasDebit && debitAmount <= 0;
    const invalidCredit = hasCredit && creditAmount <= 0;
    if ((!hasDebit && !hasCredit) || invalidDebit || invalidCredit) {
      invalidAmountCount += 1;
    }

    if ((hasDebit && hasCredit) || (!hasDebit && !hasCredit)) {
      unbalancedRows += 1;
    }
  });

  if (missingDateCount) {
    warnings.push(`${missingDateCount} voucher row(s) are missing a date.`);
  }
  if (missingLedgerCount) {
    warnings.push(`${missingLedgerCount} voucher row(s) are missing a ledger.`);
  }
  if (missingPartyCount) {
    warnings.push(`${missingPartyCount} voucher row(s) are missing a party.`);
  }
  if (invalidTypeCount) {
    warnings.push(`${invalidTypeCount} voucher row(s) are missing a voucher type.`);
  }
  if (invalidAmountCount) {
    warnings.push(
      `${invalidAmountCount} voucher row(s) have an empty or non-positive debit/credit amount.`,
    );
  }
  if (unbalancedRows) {
    warnings.push(
      `${unbalancedRows} voucher row(s) have invalid debit/credit structure.`,
    );
  }

  return warnings;
};

export const buildVoucherRows = ({
  accounts,
  commonRows,
  customers,
  payables,
  trips,
  tripTaxes,
  master,
  selectedSubBrandLabel,
  ledgerRows,
  ledgerMappings,
  voucherTypes = [],
}) => {
  const ledgerName = createLedgerResolver({ ledgerRows, ledgerMappings });
  const rows = [
    [
      "Voucher Date",
      "Voucher Type",
      "Ledger",
      "Party",
      "Trip",
      "Reference",
      "Debit",
      "Credit",
      "Narration",
      "Source",
    ],
  ];
  let voucherIndex = 0;
  const exportDate = dateOnly(master.to || master.from || new Date().toISOString());
  const cashLedgerName = ledgerName("cashEntry", "Cash Ledger");
  const pushVoucherRow = ({
    voucherId,
    date,
    ledger,
    party,
    trip,
    reference,
    debit = "",
    credit = "",
    narration,
    sourceTag = "",
    billReference = "",
    useReference = false,
  }) => {
    const voucher = getVoucherDefinition(voucherTypes, voucherId, voucherId);
    if (!voucher.enabled) return;
    const voucherReference = buildVoucherReference({
      voucher,
      reference,
      index: voucherIndex,
      useReference,
    });
    voucherIndex += 1;
    rows.push([
      dateOnly(date) || exportDate,
      voucher.label,
      ledger,
      party,
      trip,
      voucherReference,
      debit,
      credit,
      narration || voucher.narrationTemplate,
      sourceTag,
      billReference,
    ]);
    return voucherReference;
  };

  customers.forEach((row) => {
    const receivedAmount = toTallyAmount(row.amount);
    // Paid-only export: the Sales voucher tracks the cumulative amount
    // collected for the customer. The existing invoice reference remains
    // stable so a later cumulative payment can alter the same vouchers.
    const invoiceAmount = receivedAmount;
    const tripName = row.tripName || "";
    const customerName = row.name || "Customer";
    const invoiceReference = row.reference || "";
    const receiptReference = row.reference
      ? `REC-${row.reference}`
      : row.paymentReference || `${customerName}-RECEIPT`;

    let salesBillReference = "";
    if (invoiceAmount) {
      salesBillReference = pushVoucherRow({
        voucherId: "sales",
        date: dateOnly(row.transactionDate || master.to || master.from),
        ledger: ledgerName("travelInvoice", "Sales Ledger"),
        party: customerName,
        trip: tripName,
        reference: invoiceReference,
        credit: invoiceAmount.toFixed(2),
        narration: `${selectedSubBrandLabel} sales invoice`,
        sourceTag: "Customer invoice",
        useReference: true,
      });
    }

    if (receivedAmount) {
      if (!salesBillReference) {
        const error = new Error(`Receipt ${receiptReference} has no linked sales invoice reference for ${customerName}`);
        error.code = "TALLY_BILL_NOT_FOUND";
        throw error;
      }
      pushVoucherRow({
        voucherId: "receipt",
        date: dateOnly(row.transactionDate || master.to || master.from),
        ledger: cashLedgerName,
        party: customerName,
        trip: tripName,
        reference: receiptReference,
        debit: receivedAmount.toFixed(2),
        narration: `${selectedSubBrandLabel} customer receipt`,
        sourceTag: "Customer receipt",
        billReference: salesBillReference,
        useReference: true,
      });
    }
  });

  payables.forEach((row) => {
    const amount = toTallyAmount(row.amount);
    const paidAmount = toTallyAmount(
      row.paidAmount != null
        ? row.paidAmount
        : String(row.status || "").toLowerCase() === "paid"
          ? row.amount
          : 0,
    );
    if (!amount) return;

    const purchaseBillReference = pushVoucherRow({
      voucherId: "purchase",
      date: dateOnly(row.dueDate || row.paidDate || master.to || master.from),
      ledger: ledgerName("supplierPayable", "Purchase Ledger"),
      party: row.name || row.supplierName || "Supplier",
      trip: row.tripName || "",
      reference: row.reference || row.paymentReference || "",
      debit: amount.toFixed(2),
      narration: `${selectedSubBrandLabel} supplier payable`,
      sourceTag: "Supplier payable",
    });

    if (paidAmount > 0) {
      if (!row.reference) {
        const paymentReference = row.paymentReference || `${row.id || "SUPPLIER"}-PAY`;
        const error = new Error(`Payment ${paymentReference} has no linked purchase bill reference for ${row.name || row.supplierName || "Supplier"}`);
        error.code = "TALLY_BILL_NOT_FOUND";
        throw error;
      }
      pushVoucherRow({
        voucherId: "payment",
        date: dateOnly(row.paidAt || row.paidDate || master.to || master.from),
        ledger: cashLedgerName,
        party: row.name || row.supplierName || "Supplier",
        trip: row.tripName || "",
        reference:
          row.paymentReference || row.reference || `${row.id || "SUPPLIER"}-PAY`,
        credit: paidAmount.toFixed(2),
        narration: `${selectedSubBrandLabel} supplier payment`,
        sourceTag: "Supplier payment",
        billReference: purchaseBillReference,
      });
    }
  });

  const exportedCommonTotal = commonRows.reduce(
    (sum, row) => sum + toTallyAmount(row.amount),
    0,
  );

  commonRows.forEach((row) => {
    const amount = toTallyAmount(row.amount);
    if (!amount) return;

    pushVoucherRow({
      voucherId: "payment",
      date: dateOnly(
        row.transactionDate || row.createdAt || row.date || master.to || master.from,
      ),
      ledger: ledgerName("officeExpense", "Common Ledger"),
      party: row.name || "Office Expenses",
      trip: row.tripName || (master.tripId ? `Trip ${master.tripId}` : "Common"),
      reference: row.reference || row.category || "COMMON-EXPENSE",
      debit: amount.toFixed(2),
      narration: row.description || `${selectedSubBrandLabel} common expense`,
      sourceTag: "Common expense",
    });
  });

  const commonExpenses = accountAmount(accounts, "officeExpenses");
  const remainingCommonExpenses = commonExpenses - exportedCommonTotal;
  if (remainingCommonExpenses > 0.01) {
    pushVoucherRow({
      voucherId: "payment",
      date: dateOnly(master.to || master.from),
      ledger: ledgerName("officeExpense", "Common Ledger"),
      party: "Office Expenses",
      trip: master.tripId ? `Trip ${master.tripId}` : "All trips",
      reference: "COMMON-EXPENSES-BALANCE",
      debit: remainingCommonExpenses.toFixed(2),
      narration: `${selectedSubBrandLabel} common expenses balance`,
      sourceTag: "Common expense balance",
    });
  }

  getTripLedgerRows({ trips, customers, tripTaxes }).forEach((trip) => {
    const taxRows = [
      {
        ledger: ledgerName("travelInvoice", "Sales Ledger"),
        counterLedger: ledgerName("outputGst", "GST Payable"),
        amount: trip.gst,
      },
      {
        ledger: ledgerName("tcsCollected", "TCS Collected"),
        counterLedger: selectedSubBrandLabel,
        amount: trip.tcs,
      },
    ];

    taxRows.forEach(({ ledger, counterLedger, amount }) => {
      if (!amount) return;

      pushVoucherRow({
        voucherId: "taxJournal",
        date: dateOnly(master.to || master.from),
        ledger,
        party: counterLedger,
        trip: trip.label,
        reference: `${ledger.toUpperCase().replace(/\s+/g, "-")}-${trip.id}`,
        debit: amount.toFixed(2),
        narration: `${ledger} for ${trip.label}`,
        sourceTag: "Tax journal",
      });
    });
  });

  return rows;
};
