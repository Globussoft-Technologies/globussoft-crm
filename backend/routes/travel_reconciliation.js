// Travel CRM — payment reconciliation and bank-statement import.
//
// Endpoints:
//   GET  /api/travel/tally/reconciliation
//        Read successful Razorpay payments and calculate match suggestions.
//   POST /api/travel/tally/reconciliation/sync-razorpay
//        Recalculate the Razorpay reconciliation queue.
//   POST /api/travel/tally/reconciliation/statements
//        Read a PDF, CSV, XLS/XLSX, or image bank statement in memory.
//
// The route is intentionally calculation-only: it reads existing invoices,
// expenses, contacts, and payments from Prisma and does not create
// reconciliation records. Statement rows are returned to the frontend for
// review before they are included in the report calculation.

"use strict";

const crypto = require("crypto");
const express = require("express");
const multer = require("multer");
const prisma = require("../lib/prisma");
const { verifyToken, verifyRole } = require("../middleware/auth");
const { requireTravelTenant } = require("../middleware/travelGuards");
const { parseCsv, parseXlsxBuffer } = require("../lib/csvIO");
const { extractText: extractPdfText } = require("../lib/pdfTextExtractor");
const { runOcr } = require("../services/passportOcrClient");

const router = express.Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 },
});
const canCalculate = verifyRole(["ADMIN", "MANAGER"]);

// Normalise headers and numeric values so different banks can use equivalent
// column names (for example, Deposit Amt. and Credit Amount).
const normal = (value) =>
  String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
const statementHeader = (value) => {
  const key = normal(value);
  if (/^(credit|deposit|depositamt|received|amountcr|creditamt)$/.test(key))
    return "credit";
  if (
    /^(debit|withdrawal|withdrawalamt|withdrawalamount|paid|amountdr|debitamt)$/.test(
      key,
    )
  )
    return "debit";
  if (/^(balance|closingbalance|availablebalance)$/.test(key)) return "balance";
  return null;
};
const round2 = (value) => Math.round(Number(value || 0) * 100) / 100;

function parseMoney(value) {
  const parsed = Number(
    String(value ?? "")
      .replace(/[₹,$\s]/g, "")
      .replace(/,/g, ""),
  );
  return Number.isFinite(parsed) ? round2(Math.abs(parsed)) : null;
}

function parseDate(value) {
  if (!value) return null;
  const match = String(value).match(/(\d{1,2})[\/-](\d{1,2})[\/-](\d{2,4})/);
  if (match) {
    const year =
      Number(match[3]) < 100 ? 2000 + Number(match[3]) : Number(match[3]);
    const date = new Date(
      Date.UTC(year, Number(match[2]) - 1, Number(match[1]), 12),
    );
    return Number.isNaN(date.getTime()) ? null : date;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

// Read a value from a row using a list of normalised aliases.
function pick(row, keys) {
  const mapped = Object.fromEntries(
    Object.entries(row || {}).map(([key, value]) => [normal(key), value]),
  );
  for (const key of keys)
    if (mapped[normal(key)] !== undefined && mapped[normal(key)] !== "")
      return mapped[normal(key)];
  return null;
}

// Return a 0–1 similarity score used for fuzzy invoice/expense suggestions.
function similarity(a, b) {
  const left = normal(a);
  const right = normal(b);
  if (!left || !right) return 0;
  if (left.includes(right) || right.includes(left)) return 1;
  const row = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i += 1) {
    let diagonal = row[0];
    row[0] = i;
    for (let j = 1; j <= right.length; j += 1) {
      const above = row[j];
      row[j] = Math.min(
        row[j] + 1,
        row[j - 1] + 1,
        diagonal + (left[i - 1] === right[j - 1] ? 0 : 1),
      );
      diagonal = above;
    }
  }
  return 1 - row[right.length] / Math.max(left.length, right.length);
}

// Load the existing backend records that can be matched to statement rows.
async function backendCandidates(tenantId) {
  const [invoices, expenses] = await Promise.all([
    prisma.travelInvoice.findMany({
      where: { tenantId, status: { not: "Voided" } },
      select: {
        id: true,
        invoiceNum: true,
        totalAmount: true,
        currency: true,
        contactId: true,
        status: true,
        createdAt: true,
      },
      orderBy: { createdAt: "desc" },
      take: 1000,
    }),
    prisma.expense.findMany({
      where: { tenantId },
      select: {
        id: true,
        title: true,
        amount: true,
        category: true,
        createdAt: true,
        notes: true,
      },
      orderBy: { createdAt: "desc" },
      take: 1000,
    }),
  ]);
  const contactIds = [
    ...new Set(invoices.map((invoice) => invoice.contactId).filter(Boolean)),
  ];
  const contacts = contactIds.length
    ? await prisma.contact.findMany({
        where: { tenantId, id: { in: contactIds } },
        select: { id: true, name: true },
      })
    : [];
  const names = Object.fromEntries(
    contacts.map((contact) => [contact.id, contact.name]),
  );
  return {
    invoices: invoices.map((invoice) => ({
      ...invoice,
      totalAmount: Number(invoice.totalAmount || 0),
      customerName: names[invoice.contactId] || "Customer",
    })),
    expenses: expenses.map((expense) => {
      let notes = {};
      try {
        notes = JSON.parse(expense.notes || "{}");
      } catch (_) {
        notes = {};
      }
      return {
        ...expense,
        amount: Number(expense.amount || 0),
        supplierName: notes.supplierName || notes.supplier || expense.title,
      };
    }),
  };
}

// Rank credited statement rows against existing travel invoices.
function rankCredit(transaction, invoices, directInvoiceId = null) {
  return invoices
    .map((invoice) => {
      if (directInvoiceId === invoice.id)
        return {
          invoice,
          confidence: 1,
          reason: "backend payment invoice link",
        };
      let score = 0;
      const reasons = [];
      const text = normal(
        `${transaction.description} ${transaction.payerName}`,
      );
      if (text.includes(normal(invoice.invoiceNum))) {
        score += 0.62;
        reasons.push("invoice number");
      }
      const delta = Math.abs(transaction.amount - invoice.totalAmount);
      const ratio = invoice.totalAmount ? delta / invoice.totalAmount : 1;
      if (delta <= 0.01) {
        score += 0.42;
        reasons.push("exact amount");
      } else if (ratio <= 0.01) score += 0.3;
      else if (ratio <= 0.05) score += 0.14;
      const name = similarity(
        transaction.payerName || transaction.description,
        invoice.customerName,
      );
      if (name >= 0.8) score += 0.24;
      else if (name >= 0.55) score += 0.12;
      return {
        invoice,
        confidence: Math.min(0.99, round2(score)),
        reason: reasons.join(", ") || "fuzzy suggestion",
      };
    })
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 5);
}

// Rank debited/withdrawn statement rows against existing expenses.
function rankDebit(transaction, expenses) {
  return expenses
    .map((expense) => {
      let score = 0;
      const delta = Math.abs(transaction.amount - expense.amount);
      const ratio = expense.amount ? delta / expense.amount : 1;
      if (delta <= 0.01) score += 0.58;
      else if (ratio <= 0.01) score += 0.4;
      else if (ratio <= 0.05) score += 0.2;
      const name = Math.max(
        similarity(transaction.description, expense.title),
        similarity(transaction.description, expense.supplierName),
      );
      if (name >= 0.8) score += 0.34;
      else if (name >= 0.55) score += 0.18;
      return {
        expense,
        confidence: Math.min(0.99, round2(score)),
        reason: "backend supplier/expense match",
      };
    })
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 5);
}

// Assign MATCHED, SUGGESTED, or UNMATCHED status without persisting anything.
function calculateMatches(transactions, candidates) {
  return transactions.map((transaction) => {
    const debit = transaction.direction === "DEBIT";
    const suggestions = debit
      ? rankDebit(transaction, candidates.expenses)
      : rankCredit(
          transaction,
          candidates.invoices,
          transaction.directInvoiceId,
        );
    const best = suggestions[0];
    const confidence = best?.confidence || 0;
    return {
      ...transaction,
      status:
        confidence >= 0.9
          ? "MATCHED"
          : confidence >= 0.5
            ? "SUGGESTED"
            : "UNMATCHED",
      confidence,
      suggestions,
      matchedInvoice: !debit && confidence >= 0.9 ? best?.invoice : null,
      matchedExpense: debit && confidence >= 0.9 ? best?.expense : null,
      suggestedInvoiceId: !debit ? best?.invoice?.id || null : null,
      suggestedExpenseId: debit ? best?.expense?.id || null : null,
    };
  });
}

// Build the common reconciliation response used by Razorpay and statements.
function envelope(items, candidates) {
  const summary = items.reduce(
    (out, item) => ({ ...out, [item.status]: (out[item.status] || 0) + 1 }),
    { MATCHED: 0, SUGGESTED: 0, UNMATCHED: 0, IGNORED: 0 },
  );
  return {
    items,
    summary,
    invoiceOptions: candidates.invoices,
    expenseOptions: candidates.expenses,
    creditedTotal: round2(
      items
        .filter((item) => item.direction !== "DEBIT")
        .reduce((sum, item) => sum + item.amount, 0),
    ),
    withdrawnTotal: round2(
      items
        .filter((item) => item.direction === "DEBIT")
        .reduce((sum, item) => sum + item.amount, 0),
    ),
  };
}

// Convert successful Razorpay payments into reconciliation transactions.
async function razorpayEnvelope(tenantId) {
  const [payments, candidates] = await Promise.all([
    prisma.payment.findMany({
      where: { tenantId, gateway: "razorpay", status: "SUCCESS" },
      orderBy: { createdAt: "desc" },
      take: 2000,
    }),
    backendCandidates(tenantId),
  ]);
  const transactions = payments.map((payment) => {
    let metadata = {};
    try {
      metadata = JSON.parse(payment.metadata || "{}");
    } catch (_) {
      metadata = {};
    }
    return {
      id: `razorpay-${payment.id}`,
      source: "RAZORPAY",
      sourceRef: payment.gatewayId || `payment-${payment.id}`,
      transactionDate: payment.paidAt || payment.createdAt,
      description: payment.description || "Razorpay payment",
      payerName: "",
      amount: Number(payment.amount || 0),
      currency: payment.currency || "INR",
      direction: "CREDIT",
      directInvoiceId:
        Number(payment.invoiceId || metadata.travelInvoiceId) || null,
    };
  });
  return envelope(calculateMatches(transactions, candidates), candidates);
}

// Parse CSV/XLS/XLSX rows using flexible bank-header aliases.
function spreadsheetRows(parsed, file) {
  return (parsed.rows || [])
    .map((row, index) => {
      const parsedCredit = parseMoney(
        pick(row, [
          "credit",
          "deposit",
          "deposit amt",
          "deposit amount",
          "credit amount",
          "amount cr",
        ]),
      );
      const parsedDebit = parseMoney(
        pick(row, [
          "debit",
          "withdrawal",
          "withdrawal amt",
          "withdrawal amount",
          "debit amount",
          "amount dr",
        ]),
      );
      const credit = parsedCredit > 0 ? parsedCredit : null;
      const debit = parsedDebit > 0 ? parsedDebit : null;
      const generic = parseMoney(
        pick(row, ["amount", "transaction amount", "value"]),
      );
      const amount = credit ?? debit ?? generic;
      const direction =
        debit != null ||
        /DR|DEBIT|WITHDRAW/i.test(
          String(pick(row, ["type", "dr/cr", "direction"]) || ""),
        )
          ? "DEBIT"
          : "CREDIT";
      return {
        id: `statement-${index}`,
        source: "BANK_STATEMENT",
        sourceRef: String(
          pick(row, ["transaction id", "reference", "ref no", "utr"]) ||
            `${file.originalname}-${index}`,
        ),
        statementFileName: file.originalname,
        transactionDate: parseDate(
          pick(row, ["date", "transaction date", "value date", "txn date"]),
        ),
        description: String(
          pick(row, [
            "description",
            "narration",
            "particulars",
            "remarks",
            "details",
          ]) || "Bank transaction",
        ),
        payerName: String(
          pick(row, ["payer", "customer", "name", "party"]) || "",
        ),
        amount,
        currency: String(pick(row, ["currency"]) || "INR").toUpperCase(),
        direction,
      };
    })
    .filter((row) => row.transactionDate && row.amount > 0);
}

// Parse PDF text coordinates so credit/debit amounts are identified by their
// nearest column header instead of relying on a single bank's layout.
function parsePdfTableRows(pages, file) {
  const rows = [];
  for (const page of pages || []) {
    const items = (page.textItems || []).filter((item) => item.str.trim());
    const headers = {};
    for (const item of items) {
      const key = statementHeader(item.str);
      if (key) headers[key] = item.x + item.width / 2;
    }
    if (!Number.isFinite(headers.credit) || !Number.isFinite(headers.debit))
      continue;
    const groups = [];
    for (const item of [...items].sort((a, b) => b.y - a.y)) {
      let group = groups.find(
        (candidate) => Math.abs(candidate.y - item.y) <= 8,
      );
      if (!group) {
        group = { y: item.y, items: [] };
        groups.push(group);
      }
      group.items.push(item);
    }
    for (const group of groups) {
      const line = group.items.sort((a, b) => a.x - b.x);
      const dateItem = line.find((item) =>
        /(?:\b\d{1,2}\s*[\/-]\s*\d{1,2}\s*[\/-]\s*\d{2,4}\b|\bmm\s*[\/-]\s*dd\s*[\/-]\s*yyyy\b)/i.test(
          item.str,
        ),
      );
      if (!dateItem) continue;
      let credit = 0;
      let debit = 0;
      const descriptions = [];
      for (const item of line) {
        const matches = [
          ...item.str.matchAll(/(?:INR|Rs\.?\s*)?(-?\d[\d,]*\.\d{2})\b/gi),
        ];
        if (!matches.length) {
          if (item !== dateItem) descriptions.push(item.str);
          continue;
        }
        if (item !== dateItem) {
          const label = item.str
            .replace(/(?:INR|Rs\.?\s*)?(-?\d[\d,]*\.\d{2})\b/gi, "")
            .trim();
          if (label) descriptions.push(label);
        }
        const amount = parseMoney(matches[0][1]);
        const center = item.x + item.width / 2;
        if (amount == null) continue;
        const columns = [
          ["credit", headers.credit],
          ["debit", headers.debit],
          ...(Number.isFinite(headers.balance)
            ? [["balance", headers.balance]]
            : []),
        ];
        const nearestColumn = columns.reduce((nearest, column) =>
          Math.abs(center - column[1]) < Math.abs(center - nearest[1])
            ? column
            : nearest,
        )[0];
        if (nearestColumn === "credit") credit += amount;
        if (nearestColumn === "debit") debit += amount;
      }
      const description =
        descriptions
          .join(" ")
          .replace(dateItem.str, "")
          .replace(/(?:INR|Rs\.?\s*)?-?\d[\d,]*\.\d{2}\b/gi, "")
          .replace(/---\s*End of Transactions\s*---/i, "")
          .replace(/\s+/g, " ")
          .trim() || "Bank transaction";
      if (
        debit === 0 &&
        credit > 0 &&
        /\b(?:payment|debit|withdrawal|transfer\s+out|purchase|bill|charge|fee|paid)\b/i.test(
          description,
        )
      ) {
        debit = credit;
        credit = 0;
      }
      const amount = credit > 0 ? credit : debit;
      if (amount <= 0) continue;
      rows.push({
        id: `statement-${rows.length}-${crypto.createHash("sha1").update(`${page.pageNumber}-${group.y}-${description}`).digest("hex").slice(0, 8)}`,
        source: "BANK_STATEMENT",
        sourceRef: `${file.originalname}-${rows.length}`,
        statementFileName: file.originalname,
        transactionDate: parseDate(dateItem.str),
        description,
        payerName: "",
        amount,
        currency: "INR",
        direction: debit > 0 ? "DEBIT" : "CREDIT",
      });
    }
  }
  return rows;
}

// Fallback parser for PDFs where text coordinates do not expose both headers.
function textRowsByDescription(text, file) {
  const source = String(text || "").replace(/\r/g, "\n");
  const dates = [...source.matchAll(/\b\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4}\b/g)];
  return dates
    .map((match, index) => {
      const segment = source
        .slice(match.index, dates[index + 1]?.index || source.length)
        .replace(/\s+/g, " ")
        .trim();
      const amounts = [...segment.matchAll(/-?\d[\d,]*\.\d{2}\b/g)];
      const amount = amounts[0] ? parseMoney(amounts[0][0]) : null;
      const description =
        segment
          .replace(match[0], "")
          .replace(amounts[0]?.[0] || "", "")
          .replace(/(?:INR|Rs\.?\s*)?-?\d[\d,]*\.\d{2}\b/gi, "")
          .replace(/---\s*End of Transactions\s*---/i, "")
          .replace(/\s+/g, " ")
          .trim() || "Bank transaction";
      const direction =
        /\b(?:payment|debit|withdrawal|transfer\s+out|purchase|bill|charge|fee|paid)\b/i.test(
          description,
        )
          ? "DEBIT"
          : "CREDIT";
      return {
        id: `statement-${index}-${crypto.createHash("sha1").update(segment).digest("hex").slice(0, 8)}`,
        source: "BANK_STATEMENT",
        sourceRef: `${file.originalname}-${index}`,
        statementFileName: file.originalname,
        transactionDate: parseDate(match[0]),
        description,
        payerName: "",
        amount,
        currency: "INR",
        direction,
      };
    })
    .filter((row) => row.transactionDate && row.amount > 0);
}

// Generic text/OCR fallback for image statements and irregular PDF output.
function textRows(text, file) {
  const source = String(text || "").replace(/\r/g, "\n");
  const dates = [...source.matchAll(/\b\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4}\b/g)];
  return dates
    .map((match, index) => {
      const segment = source
        .slice(match.index, dates[index + 1]?.index || source.length)
        .replace(/\s+/g, " ")
        .trim();
      const amounts = [
        ...segment.matchAll(/(?:₹|INR|Rs\.?\s*)?(-?\d[\d,]*\.\d{2})\b/gi),
      ];
      const amountMatch = amounts.length > 1 ? amounts[0] : amounts.at(-1);
      const amount = amountMatch ? parseMoney(amountMatch[1]) : null;
      const direction = /\b(?:DR|DEBIT|WITHDRAWAL)\b/i.test(segment)
        ? "DEBIT"
        : "CREDIT";
      return {
        id: `statement-${index}-${crypto.createHash("sha1").update(segment).digest("hex").slice(0, 8)}`,
        source: "BANK_STATEMENT",
        sourceRef: `${file.originalname}-${index}`,
        statementFileName: file.originalname,
        transactionDate: parseDate(match[0]),
        description:
          segment
            .replace(match[0], "")
            .replace(amountMatch?.[0] || "", "")
            .trim() || "Bank transaction",
        payerName: "",
        amount,
        currency: "INR",
        direction,
      };
    })
    .filter((row) => row.transactionDate && row.amount > 0);
}

// Return the current Razorpay reconciliation queue.
router.get(
  "/tally/reconciliation",
  verifyToken,
  requireTravelTenant,
  async (req, res) => {
    try {
      res.json(await razorpayEnvelope(req.travelTenant.id));
    } catch (error) {
      console.error(
        "[travel-reconciliation] calculation failed:",
        error.message,
      );
      res
        .status(500)
        .json({ error: "Failed to calculate payment reconciliation" });
    }
  },
);

// Recalculate Razorpay matches for the current travel tenant.
router.post(
  "/tally/reconciliation/sync-razorpay",
  verifyToken,
  canCalculate,
  requireTravelTenant,
  async (req, res) => {
    try {
      const result = await razorpayEnvelope(req.travelTenant.id);
      res.json({ imported: result.items.length, ...result });
    } catch (error) {
      res
        .status(500)
        .json({ error: "Failed to calculate Razorpay reconciliation" });
    }
  },
);

// Upload and parse one bank statement, then return rows and match suggestions
// for frontend confirmation. No statement or reconciliation row is persisted.
router.post(
  "/tally/reconciliation/statements",
  verifyToken,
  canCalculate,
  requireTravelTenant,
  upload.single("statement"),
  async (req, res) => {
    try {
      if (!req.file?.buffer?.length)
        return res.status(400).json({ error: "Statement file is required" });
      const name = req.file.originalname.toLowerCase();
      let rows;
      let extraction = "spreadsheet";
      if (/\.xlsx?$/.test(name))
        rows = spreadsheetRows(parseXlsxBuffer(req.file.buffer), req.file);
      else if (name.endsWith(".csv") || req.file.mimetype === "text/csv")
        rows = spreadsheetRows(
          parseCsv(req.file.buffer.toString("utf8")),
          req.file,
        );
      else if (
        name.endsWith(".pdf") ||
        req.file.mimetype === "application/pdf"
      ) {
        extraction = "pdf-ocr";
        const extracted = await extractPdfText(req.file.buffer);
        const coordinateRows = parsePdfTableRows(extracted.pages, req.file);
        const textRows = textRowsByDescription(extracted.text, req.file);
        const totalFor = (sourceRows, direction) =>
          sourceRows
            .filter((row) => row.direction === direction)
            .reduce((sum, row) => sum + Number(row.amount || 0), 0);
        const coordinateCredit = totalFor(coordinateRows, "CREDIT");
        const coordinateDebit = totalFor(coordinateRows, "DEBIT");
        const textCredit = totalFor(textRows, "CREDIT");
        const textDebit = totalFor(textRows, "DEBIT");
        if (!coordinateRows.length) {
          rows = textRows;
        } else {
          rows = [...coordinateRows];
          if (coordinateCredit === 0 && textCredit > 0)
            rows = [
              ...rows.filter((row) => row.direction !== "CREDIT"),
              ...textRows
                .filter((row) => row.direction === "CREDIT")
                .map((row) => ({ ...row, id: `text-credit-${row.id}` })),
            ];
          if (coordinateDebit === 0 && textDebit > 0)
            rows = [
              ...rows.filter((row) => row.direction !== "DEBIT"),
              ...textRows
                .filter((row) => row.direction === "DEBIT")
                .map((row) => ({ ...row, id: `text-debit-${row.id}` })),
            ];
        }
      } else {
        extraction = "image-ocr";
        rows = textRows(
          `${(await runOcr(req.file.buffer)).vizText || ""}`,
          req.file,
        );
      }
      if (!rows.length)
        return res
          .status(422)
          .json({
            error:
              "No credited or withdrawn transactions could be read from this statement",
          });
      const candidates = await backendCandidates(req.travelTenant.id);
      const result = envelope(calculateMatches(rows, candidates), candidates);
      res.json({
        extraction,
        imported: result.items.length,
        matched: result.summary.MATCHED,
        suggested: result.summary.SUGGESTED,
        unmatched: result.summary.UNMATCHED,
        ...result,
      });
    } catch (error) {
      console.error(
        "[travel-reconciliation] statement calculation failed:",
        error.message,
      );
      res
        .status(500)
        .json({ error: "Failed to read and calculate bank statement" });
    }
  },
);

module.exports = router;
