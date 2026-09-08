// Pure math + parsing for the Reports → "Per Product" tab.
//
// Lives in lib/ rather than inside routes/wellness.js so the tax split, the
// row rollup and the import parser can be exercised by vitest without
// booting the route's prisma client — the same split lib/pnlMath.js and
// lib/csvIO.js already use.
//
// Everything here is prisma-free. The two data loaders (live POS vs.
// imported snapshot) stay in the route because they are queries.
//
// Column semantics, held identically by both sources:
//   grossSales = Σ qty × unit price (pre-discount)
//   discount   = Σ line discount
//   netSales   = taxable value
//   tax        = tax on netSales
//   totalSales = netSales + tax  ← what the customer paid

"use strict";

const PER_PRODUCT_EXPORT_HEADERS = [
  "Product Name",
  "HSN Code",
  "Product Count",
  "Gross Sales",
  "Discount",
  "Net Sales",
  "Tax",
  "Total Sales",
];

const MAX_PRODUCT_IMPORT_ROWS = 5000;

const roundMoney2 = (n) =>
  Math.round(((Number(n) || 0) + Number.EPSILON) * 100) / 100;

// POS stores tax at the SALE level (Sale.taxTotal), not per line, so a
// per-product report has to derive it from the product's own rate. Prorating
// Sale.taxTotal across lines instead would attribute a 5%-slab product's tax
// to a 0%-slab one on any mixed basket.
function splitProductTax(charged, ratePercent, taxIncluded) {
  const amount = Number(charged) || 0;
  const rate = Number(ratePercent) || 0;
  if (rate <= 0) return { netSales: amount, tax: 0, totalSales: amount };
  if (taxIncluded) {
    // Price already contains the tax — back it out. This is the shape every
    // Indian clinic PMS export uses (and what the sample import files show:
    // totalSales = gross − discount, netSales = totalSales ÷ 1.05).
    const netSales = amount / (1 + rate / 100);
    return { netSales, tax: amount - netSales, totalSales: amount };
  }
  const tax = amount * (rate / 100);
  return { netSales: amount, tax, totalSales: amount + tax };
}

// Round once, at the edge, and stamp `revenue`.
//
// `revenue` is an alias of totalSales that exists purely so this tab can
// reuse paginateReportRows() — the shared cursor encodes (revenue, key) and
// sorts on it, which is also the ordering this report wants (biggest seller
// first). Without the alias every row sorts as revenue=0 and the cursor
// cannot find its resume point.
function finalizeProductRow(row) {
  const totalSales = roundMoney2(row.totalSales);
  return {
    key: row.key,
    productId: row.productId ?? null,
    name: row.name,
    hsnCode: row.hsnCode || null,
    productCount: Math.round(Number(row.productCount) || 0),
    grossSales: roundMoney2(row.grossSales),
    discount: roundMoney2(row.discount),
    netSales: roundMoney2(row.netSales),
    tax: roundMoney2(row.tax),
    totalSales,
    revenue: totalSales,
  };
}

function sumProductTotals(rows) {
  const totals = {
    productCount: 0,
    grossSales: 0,
    discount: 0,
    netSales: 0,
    tax: 0,
    totalSales: 0,
  };
  for (const r of rows || []) {
    totals.productCount += Number(r.productCount) || 0;
    totals.grossSales += Number(r.grossSales) || 0;
    totals.discount += Number(r.discount) || 0;
    totals.netSales += Number(r.netSales) || 0;
    totals.tax += Number(r.tax) || 0;
    totals.totalSales += Number(r.totalSales) || 0;
  }
  return {
    productCount: Math.round(totals.productCount),
    grossSales: roundMoney2(totals.grossSales),
    discount: roundMoney2(totals.discount),
    netSales: roundMoney2(totals.netSales),
    tax: roundMoney2(totals.tax),
    totalSales: roundMoney2(totals.totalSales),
  };
}

// ── Snapshot import parsing ─────────────────────────────────────────
//
// These files are pasted out of another vendor's UI, so the parser is
// deliberately tolerant: header matching is case- and punctuation-
// insensitive with aliases, money cells arrive as "₹2,321,176.00" /
// "(1,234.00)" / "--", and the export's own leading grand-total row is
// dropped (keeping it would double the batch, since the rollup is
// re-derived by summing the product rows).

// Aliases are matched after lowercasing and stripping every non-alphanumeric
// character, so "Product Name", "product_name" and "PRODUCT NAME" all collide
// onto the same key.
const PRODUCT_IMPORT_FIELDS = {
  productName: ["productname", "product", "name", "itemname", "item"],
  hsnCode: ["hsncode", "hsn", "hsnsac", "hsnsaccode"],
  productCount: [
    "productcount",
    "count",
    "qty",
    "quantity",
    "units",
    "unitssold",
  ],
  grossSales: ["grosssales", "gross", "grossamount", "grossvalue", "mrp"],
  discount: ["discount", "discountamount", "discounts", "totaldiscount"],
  netSales: ["netsales", "net", "netamount", "taxablevalue", "taxable"],
  tax: ["tax", "taxamount", "gst", "totaltax"],
  totalSales: [
    "totalsales",
    "total",
    "totalamount",
    "grandtotal",
    "netpayable",
  ],
};

const normalizeImportKey = (h) =>
  String(h ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");

// Maps the sheet's headers onto our field names once per file, so every data
// row is read by field name rather than by re-scanning aliases.
function buildProductImportHeaderMap(headers) {
  const map = {};
  const seen = new Set();
  (headers || []).forEach((header, index) => {
    const key = normalizeImportKey(header);
    if (!key) return;
    for (const [field, aliases] of Object.entries(PRODUCT_IMPORT_FIELDS)) {
      if (seen.has(field)) continue;
      if (aliases.includes(key)) {
        map[field] = { header, index };
        seen.add(field);
        break;
      }
    }
  });
  return map;
}

// "₹2,321,176.00" → 2321176 · "(1,234.00)" → -1234 · "--" / "" → 0.
// Returns null (not 0) for text that is not a number at all, so the caller
// can reject the row instead of silently importing a zero.
function parseImportMoney(raw) {
  if (raw === null || raw === undefined) return 0;
  let s = String(raw).trim();
  if (s === "" || s === "-" || s === "--" || /^n\/a$/i.test(s)) return 0;
  let negative = false;
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1);
  }
  // Strip currency symbols, thousands separators and stray spaces — including
  // the non-breaking / narrow-no-break spaces Excel pastes after ₹.
  s = s.replace(/[₹$€£,\s\u00a0\u202f]/g, "");
  if (s.startsWith("-")) {
    negative = true;
    s = s.slice(1);
  }
  if (s === "") return 0;
  if (!/^\d*\.?\d+$/.test(s)) return null;
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return negative ? -n : n;
}

// The header row of these exports is followed by a grand-total row.
const isProductImportTotalsRow = (name) =>
  /^(total|grand\s*total|totals|sum)$/i.test(String(name || "").trim());

// Validates + normalises a parsed sheet ({ headers, rows }) into
// ProductSalesImportRow shape. A non-empty `errors` rejects the WHOLE upload:
// a half-loaded period silently under-reports, which is worse than a refused
// one.
function normalizeProductImportRows(parsed) {
  const errors = [];
  const headers = Array.isArray(parsed?.headers) ? parsed.headers : [];
  const rawRows = Array.isArray(parsed?.rows) ? parsed.rows : [];
  const map = buildProductImportHeaderMap(headers);

  if (!map.productName) {
    return {
      rows: [],
      errors: [
        {
          rowNumber: 1,
          reason:
            "Could not find a product-name column. Expected a header like 'Product Name'.",
        },
      ],
    };
  }
  if (!map.totalSales && !map.netSales && !map.grossSales) {
    return {
      rows: [],
      errors: [
        {
          rowNumber: 1,
          reason:
            "Could not find any sales-amount column. Expected 'Total Sales', 'Net Sales' or 'Gross Sales'.",
        },
      ],
    };
  }
  if (rawRows.length > MAX_PRODUCT_IMPORT_ROWS) {
    return {
      rows: [],
      errors: [
        {
          rowNumber: 0,
          reason: `File has ${rawRows.length} rows; the limit is ${MAX_PRODUCT_IMPORT_ROWS}.`,
        },
      ],
    };
  }

  const read = (row, field) => {
    const hit = map[field];
    if (!hit) return "";
    const v = row[hit.header];
    return v === undefined || v === null ? "" : v;
  };

  const rows = [];
  rawRows.forEach((raw, i) => {
    // +2: 1 for the header row, 1 because humans count from 1.
    const rowNumber = i + 2;
    const productName = String(read(raw, "productName") || "").trim();
    if (!productName) return; // blank spacer line
    if (isProductImportTotalsRow(productName)) return; // the file's own TOTAL row

    const numeric = {};
    let rowFailed = false;
    for (const field of [
      "productCount",
      "grossSales",
      "discount",
      "netSales",
      "tax",
      "totalSales",
    ]) {
      const value = parseImportMoney(read(raw, field));
      if (value === null) {
        errors.push({
          rowNumber,
          reason: `"${read(raw, field)}" in ${field} is not a number.`,
        });
        rowFailed = true;
        break;
      }
      numeric[field] = value;
    }
    if (rowFailed) return;

    // Back-fill whichever money columns the file omitted, keeping the
    // report's invariant totalSales = netSales + tax.
    let { grossSales, discount, netSales, tax, totalSales } = numeric;
    if (!map.totalSales) {
      totalSales = netSales + tax || grossSales - discount;
    }
    if (!map.netSales) netSales = totalSales - tax;
    if (!map.grossSales) grossSales = totalSales + discount;

    const hsn = String(read(raw, "hsnCode") || "").trim();
    rows.push({
      productName: productName.slice(0, 190),
      hsnCode: hsn && hsn !== "--" && hsn !== "-" ? hsn.slice(0, 190) : null,
      productCount: Math.round(numeric.productCount),
      grossSales: roundMoney2(grossSales),
      discount: roundMoney2(discount),
      netSales: roundMoney2(netSales),
      tax: roundMoney2(tax),
      totalSales: roundMoney2(totalSales),
    });
  });

  return { rows, errors };
}

// ── Combining the two sources across the POS cutover ────────────────
//
// The report never sums an import and POS blindly — two recordings of the
// same days would double every figure. But once a clinic starts ringing sales
// here, there is a clean boundary: the CUTOVER, the timestamp of its first
// COMPLETED product sale. Everything before it exists only in the imported
// snapshot; everything from it onward exists only in POS. Those are disjoint,
// so for a window spanning the boundary they can be added safely.
//
// Without this, "live wins outright" silently drops the pre-cutover half of
// any straddling window — an August-to-September view would show only
// September, which reads as a catastrophic sales collapse.
//
// A batch qualifies only if it ends STRICTLY BEFORE the cutover. A batch that
// reaches into POS territory might describe sales POS also has, and there is
// no way to tell which, so it is excluded rather than risked.
function isBatchSafeToCombine(batch, cutoverAt) {
  if (!cutoverAt) return true; // no POS data at all — nothing to collide with
  const end = new Date(batch?.periodEnd).getTime();
  if (Number.isNaN(end)) return false;
  return end < new Date(cutoverAt).getTime();
}

// Merge two already-finalised row sets on `key`, summing every measure.
// Used only for disjoint periods (see isBatchSafeToCombine).
function mergeProductRows(...rowSets) {
  const acc = new Map();
  for (const rows of rowSets) {
    for (const r of rows || []) {
      const key = r.key;
      const cur = acc.get(key);
      if (!cur) {
        acc.set(key, { ...r });
        continue;
      }
      cur.productCount += Number(r.productCount) || 0;
      cur.grossSales += Number(r.grossSales) || 0;
      cur.discount += Number(r.discount) || 0;
      cur.netSales += Number(r.netSales) || 0;
      cur.tax += Number(r.tax) || 0;
      cur.totalSales += Number(r.totalSales) || 0;
      // Keep whichever side actually knows the HSN.
      if (!cur.hsnCode && r.hsnCode) cur.hsnCode = r.hsnCode;
      if (cur.productId == null && r.productId != null) cur.productId = r.productId;
    }
  }
  return [...acc.values()].map(finalizeProductRow);
}

module.exports = {
  PER_PRODUCT_EXPORT_HEADERS,
  MAX_PRODUCT_IMPORT_ROWS,
  PRODUCT_IMPORT_FIELDS,
  roundMoney2,
  splitProductTax,
  finalizeProductRow,
  sumProductTotals,
  normalizeImportKey,
  buildProductImportHeaderMap,
  parseImportMoney,
  isProductImportTotalsRow,
  normalizeProductImportRows,
  isBatchSafeToCombine,
  mergeProductRows,
};
