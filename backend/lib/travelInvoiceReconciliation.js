"use strict";

const { parseCsv, parseXlsxBuffer } = require("./csvIO");

function isXlsxUpload(file) {
  if (!file) return false;
  const name = String(file.originalname || "").toLowerCase();
  if (name.endsWith(".xlsx") || name.endsWith(".xls")) return true;
  const mt = String(file.mimetype || "").toLowerCase();
  return (
    mt === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
    mt === "application/vnd.ms-excel"
  );
}

function parseSpreadsheetBuffer(buffer, file) {
  if (!Buffer.isBuffer(buffer)) {
    throw new Error("parseSpreadsheetBuffer: buffer is required");
  }
  return isXlsxUpload(file)
    ? parseXlsxBuffer(buffer)
    : parseCsv(buffer.toString("utf8"));
}

function normalizeHeader(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

function normalizeText(value) {
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

function parseMoney(value) {
  const text = normalizeText(value).replace(/,/g, "");
  if (!text) return null;
  const n = Number(text);
  if (!Number.isFinite(n)) return null;
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function parseExcelRow(row) {
  const mapped = {};
  for (const [key, value] of Object.entries(row || {})) {
    mapped[normalizeHeader(key)] = value;
  }

  const invoiceNum = normalizeText(
    mapped.invoicenumber ||
    mapped.invoicenum ||
    mapped.vouchernumber ||
    mapped.vouchernum ||
    mapped.invoiceid,
  );

  if (!invoiceNum || invoiceNum.toLowerCase() === "total") {
    return { skip: true };
  }

  const invoiceDate = normalizeText(mapped.invoicedate || mapped.date);
  const customer = normalizeText(mapped.customer || mapped.customername || mapped.party);
  const status = normalizeText(mapped.status);
  const subBrand = normalizeText(mapped.subbrand || mapped.subbrandcode || mapped.subbrandname);
  const invoiceTotal = parseMoney(
    mapped.invoicetotal ||
    mapped.invoiceamount ||
    mapped.totalamount ||
    mapped.total,
  );

  return {
    row: {
      invoiceNum,
      invoiceDate,
      customer,
      status,
      subBrand,
      invoiceTotal,
    },
  };
}

function dateOnly(value) {
  if (!value) return "";
  const dt = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(dt.getTime())) return "";
  return dt.toISOString().slice(0, 10);
}

function reconcileRows({ rows, invoices, contactsById }) {
  const invoiceMap = new Map();
  for (const inv of invoices || []) {
    invoiceMap.set(normalizeText(inv.invoiceNum).toUpperCase(), inv);
  }

  const parsedRows = [];
  const discrepancies = [];
  let matchedRows = 0;
  let mismatchedRows = 0;
  let missingRows = 0;
  let totalWorkbookAmount = 0;
  let totalCrmAmount = 0;

  for (const raw of rows || []) {
    const parsed = parseExcelRow(raw);
    if (parsed.skip) continue;
    const row = parsed.row;
    parsedRows.push(row);
    if (Number.isFinite(row.invoiceTotal)) {
      totalWorkbookAmount += row.invoiceTotal;
    }

    const invoice = invoiceMap.get(row.invoiceNum.toUpperCase()) || null;
    if (!invoice) {
      missingRows += 1;
      discrepancies.push({
        invoiceNum: row.invoiceNum,
        issue: "MISSING_IN_CRM",
        expected: null,
        actual: {
          invoiceNum: row.invoiceNum,
          status: row.status || null,
          invoiceTotal: row.invoiceTotal ?? null,
          customer: row.customer || null,
          subBrand: row.subBrand || null,
          invoiceDate: row.invoiceDate || null,
        },
      });
      continue;
    }

    matchedRows += 1;
    const invoiceTotal = Math.round((Number(invoice.totalAmount) + Number.EPSILON) * 100) / 100;
    totalCrmAmount += invoiceTotal;
    const contactName = contactsById?.[invoice.contactId]?.name || null;
    const rowMismatches = [];

    if (row.status && row.status.toLowerCase() !== String(invoice.status || "").toLowerCase()) {
      rowMismatches.push({
        field: "status",
        expected: invoice.status,
        actual: row.status,
      });
    }
    if (row.subBrand && row.subBrand.toLowerCase() !== String(invoice.subBrand || "").toLowerCase()) {
      rowMismatches.push({
        field: "subBrand",
        expected: invoice.subBrand,
        actual: row.subBrand,
      });
    }
    if (row.customer && contactName && row.customer.toLowerCase() !== contactName.toLowerCase()) {
      rowMismatches.push({
        field: "customer",
        expected: contactName,
        actual: row.customer,
      });
    }
    if (row.invoiceDate) {
      const expectedDate = dateOnly(invoice.createdAt);
      if (expectedDate && row.invoiceDate.slice(0, 10) !== expectedDate) {
        rowMismatches.push({
          field: "invoiceDate",
          expected: expectedDate,
          actual: row.invoiceDate,
        });
      }
    }
    if (Number.isFinite(row.invoiceTotal) && Math.abs(row.invoiceTotal - invoiceTotal) > 0.01) {
      rowMismatches.push({
        field: "invoiceTotal",
        expected: invoiceTotal,
        actual: row.invoiceTotal,
      });
    }

    if (rowMismatches.length > 0) {
      mismatchedRows += 1;
      discrepancies.push({
        invoiceId: invoice.id,
        invoiceNum: invoice.invoiceNum,
        issue: "MISMATCH",
        expected: {
          status: invoice.status,
          subBrand: invoice.subBrand,
          customer: contactName,
          invoiceDate: dateOnly(invoice.createdAt),
          invoiceTotal,
        },
        actual: {
          status: row.status || null,
          subBrand: row.subBrand || null,
          customer: row.customer || null,
          invoiceDate: row.invoiceDate || null,
          invoiceTotal: row.invoiceTotal ?? null,
        },
        fields: rowMismatches,
      });
    }
  }

  return {
    totalRows: parsedRows.length,
    matchedRows,
    mismatchedRows,
    missingRows,
    matchedAmount: Math.round(totalCrmAmount * 100) / 100,
    workbookAmount: Math.round(totalWorkbookAmount * 100) / 100,
    discrepancyCount: discrepancies.length,
    discrepancies,
  };
}

module.exports = {
  isXlsxUpload,
  parseSpreadsheetBuffer,
  reconcileRows,
  normalizeHeader,
  parseMoney,
};
