// Unit tests for backend/lib/productSalesReport.js
//
// Pins the math + parsing behind the Reports → "Per Product" tab. Pure
// helpers — no Prisma, no I/O.
//
// Contracts pinned:
//   - splitProductTax: 0% → no tax; inclusive → tax backed OUT of the price
//     (total unchanged); exclusive → tax added ON TOP (total grows)
//   - the invariant totalSales === netSales + tax holds in every branch
//   - finalizeProductRow rounds to 2dp and mirrors totalSales onto `revenue`
//     (paginateReportRows sorts and cursors on `revenue`)
//   - parseImportMoney survives real export cells: ₹ + thousands separators,
//     parenthesised negatives, "--" / "" / "N/A" blanks, nbsp after ₹
//   - header matching is case- / punctuation-insensitive and alias-driven
//   - normalizeProductImportRows DROPS the export's own grand-total row
//     (keeping it would double the batch), skips blank lines, rejects
//     non-numeric cells, and back-fills omitted money columns
//   - a real vendor export (test/fixtures/product-sales-export-sample.csv)
//     round-trips: parsed row totals equal the file's own TOTAL row
//   - the POS cutover: a snapshot is combinable with live POS only when it
//     ends strictly before the first POS product sale, and merging sums every
//     measure per product

import { describe, test, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const {
  splitProductTax,
  finalizeProductRow,
  sumProductTotals,
  parseImportMoney,
  normalizeImportKey,
  buildProductImportHeaderMap,
  isProductImportTotalsRow,
  normalizeProductImportRows,
  isBatchSafeToCombine,
  mergeProductRows,
  PER_PRODUCT_EXPORT_HEADERS,
} = await import("../../lib/productSalesReport.js");

const { parseCsv } = await import("../../lib/csvIO.js");

const FIXTURE_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "fixtures",
);

// 2dp comparison — the helpers round at the edge, the assertions follow.
const near = (a, b) => expect(Math.abs(a - b)).toBeLessThan(0.011);

describe("splitProductTax", () => {
  test("0% (or missing) rate → everything is net, no tax", () => {
    expect(splitProductTax(1000, 0, true)).toEqual({
      netSales: 1000,
      tax: 0,
      totalSales: 1000,
    });
    expect(splitProductTax(1000, null, false)).toEqual({
      netSales: 1000,
      tax: 0,
      totalSales: 1000,
    });
  });

  test("tax-inclusive: tax is backed OUT, total is unchanged", () => {
    const r = splitProductTax(99317.08, 5, true);
    near(r.netSales, 94587.69);
    near(r.tax, 4729.39);
    expect(r.totalSales).toBe(99317.08);
  });

  test("tax-exclusive: tax is added ON TOP, total grows", () => {
    const r = splitProductTax(1000, 18, false);
    expect(r.netSales).toBe(1000);
    near(r.tax, 180);
    near(r.totalSales, 1180);
  });

  test("invariant totalSales === netSales + tax holds in every branch", () => {
    for (const [charged, rate, inclusive] of [
      [1234.56, 5, true],
      [1234.56, 5, false],
      [1234.56, 12, true],
      [0, 18, true],
      [999, 0, false],
    ]) {
      const r = splitProductTax(charged, rate, inclusive);
      near(r.netSales + r.tax, r.totalSales);
    }
  });
});

describe("finalizeProductRow", () => {
  test("rounds money to 2dp and counts to whole units", () => {
    const row = finalizeProductRow({
      key: "p:1",
      productId: 1,
      name: "Serum",
      hsnCode: "3304",
      productCount: 3.4,
      grossSales: 1000.005,
      discount: 10.001,
      netSales: 942.8571428,
      tax: 47.1428571,
      totalSales: 989.9999999,
    });
    expect(row.productCount).toBe(3);
    expect(row.netSales).toBe(942.86);
    expect(row.tax).toBe(47.14);
    expect(row.totalSales).toBe(990);
  });

  test("mirrors totalSales onto `revenue` — the shared cursor sorts on it", () => {
    const row = finalizeProductRow({ key: "n:x", name: "X", totalSales: 512.5 });
    expect(row.revenue).toBe(512.5);
    expect(row.revenue).toBe(row.totalSales);
  });

  test("missing productId / hsnCode collapse to null, never undefined", () => {
    const row = finalizeProductRow({ key: "n:x", name: "X", totalSales: 1 });
    expect(row.productId).toBeNull();
    expect(row.hsnCode).toBeNull();
  });
});

describe("sumProductTotals", () => {
  test("sums every money column and the unit count", () => {
    const totals = sumProductTotals([
      { productCount: 2, grossSales: 100, discount: 10, netSales: 85.71, tax: 4.29, totalSales: 90 },
      { productCount: 3, grossSales: 300, discount: 0, netSales: 285.71, tax: 14.29, totalSales: 300 },
    ]);
    expect(totals.productCount).toBe(5);
    expect(totals.grossSales).toBe(400);
    expect(totals.discount).toBe(10);
    expect(totals.totalSales).toBe(390);
  });

  test("empty / null input → a zeroed shape, not a crash", () => {
    expect(sumProductTotals([])).toEqual({
      productCount: 0, grossSales: 0, discount: 0, netSales: 0, tax: 0, totalSales: 0,
    });
    expect(sumProductTotals(null).totalSales).toBe(0);
  });
});

describe("parseImportMoney", () => {
  test("strips ₹ and thousands separators", () => {
    expect(parseImportMoney("₹2,321,176.00")).toBe(2321176);
    expect(parseImportMoney("₹215.92")).toBe(215.92);
    expect(parseImportMoney("1,248")).toBe(1248);
  });

  test("handles the non-breaking space Excel pastes after ₹", () => {
    expect(parseImportMoney("₹ 2,321.00")).toBe(2321);
    expect(parseImportMoney("₹ 2,321.00")).toBe(2321);
  });

  test("blank-ish cells are 0, not a rejection", () => {
    expect(parseImportMoney("")).toBe(0);
    expect(parseImportMoney("--")).toBe(0);
    expect(parseImportMoney("-")).toBe(0);
    expect(parseImportMoney("N/A")).toBe(0);
    expect(parseImportMoney(null)).toBe(0);
    expect(parseImportMoney(undefined)).toBe(0);
  });

  test("parenthesised and signed negatives", () => {
    expect(parseImportMoney("(1,234.00)")).toBe(-1234);
    expect(parseImportMoney("-₹1,234.00")).toBe(-1234);
  });

  test("non-numeric text returns null so the caller can reject the row", () => {
    expect(parseImportMoney("twelve")).toBeNull();
    expect(parseImportMoney("12abc")).toBeNull();
    expect(parseImportMoney("1.2.3")).toBeNull();
  });
});

describe("header matching", () => {
  test("normalizeImportKey collapses case and punctuation", () => {
    expect(normalizeImportKey("Product Name")).toBe("productname");
    expect(normalizeImportKey("product_name")).toBe("productname");
    expect(normalizeImportKey("  PRODUCT-NAME ")).toBe("productname");
  });

  test("aliases map vendor headers onto our field names", () => {
    const map = buildProductImportHeaderMap([
      "Item",
      "HSN/SAC",
      "Qty",
      "Gross",
      "Discounts",
      "Taxable Value",
      "GST",
      "Grand Total",
    ]);
    expect(map.productName.header).toBe("Item");
    expect(map.hsnCode.header).toBe("HSN/SAC");
    expect(map.productCount.header).toBe("Qty");
    expect(map.grossSales.header).toBe("Gross");
    expect(map.discount.header).toBe("Discounts");
    expect(map.netSales.header).toBe("Taxable Value");
    expect(map.tax.header).toBe("GST");
    expect(map.totalSales.header).toBe("Grand Total");
  });

  test("the canonical export headers map onto themselves", () => {
    const map = buildProductImportHeaderMap(PER_PRODUCT_EXPORT_HEADERS);
    expect(Object.keys(map).sort()).toEqual(
      ["discount", "grossSales", "hsnCode", "netSales", "productCount", "productName", "tax", "totalSales"],
    );
  });

  test("isProductImportTotalsRow recognises the export's own summary row", () => {
    expect(isProductImportTotalsRow("Total")).toBe(true);
    expect(isProductImportTotalsRow(" TOTALS ")).toBe(true);
    expect(isProductImportTotalsRow("Grand Total")).toBe(true);
    expect(isProductImportTotalsRow("Total Body Serum")).toBe(false);
  });
});

describe("normalizeProductImportRows", () => {
  const headers = PER_PRODUCT_EXPORT_HEADERS;
  const row = (over = {}) => ({
    "Product Name": "Serum",
    "HSN Code": "3304",
    "Product Count": "2",
    "Gross Sales": "1,000.00",
    Discount: "0.00",
    "Net Sales": "952.38",
    Tax: "47.62",
    "Total Sales": "1,000.00",
    ...over,
  });

  test("parses a clean sheet", () => {
    const { rows, errors } = normalizeProductImportRows({ headers, rows: [row()] });
    expect(errors).toEqual([]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      productName: "Serum",
      hsnCode: "3304",
      productCount: 2,
      grossSales: 1000,
      netSales: 952.38,
      tax: 47.62,
      totalSales: 1000,
    });
  });

  test("drops the file's own TOTAL row — keeping it would double the batch", () => {
    const { rows } = normalizeProductImportRows({
      headers,
      rows: [row({ "Product Name": "Total" }), row()],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].productName).toBe("Serum");
  });

  test("skips blank spacer lines without erroring", () => {
    const { rows, errors } = normalizeProductImportRows({
      headers,
      rows: [row({ "Product Name": "  " }), row()],
    });
    expect(errors).toEqual([]);
    expect(rows).toHaveLength(1);
  });

  test('"--" in HSN Code becomes null rather than a literal "--"', () => {
    const { rows } = normalizeProductImportRows({
      headers,
      rows: [row({ "HSN Code": "--" })],
    });
    expect(rows[0].hsnCode).toBeNull();
  });

  test("a non-numeric money cell rejects that row with a readable reason", () => {
    const { rows, errors } = normalizeProductImportRows({
      headers,
      rows: [row({ "Total Sales": "twelve hundred" })],
    });
    expect(rows).toHaveLength(0);
    expect(errors).toHaveLength(1);
    expect(errors[0].rowNumber).toBe(2);
    expect(errors[0].reason).toContain("totalSales");
  });

  test("missing product-name column is a whole-file rejection", () => {
    const { rows, errors } = normalizeProductImportRows({
      headers: ["Foo", "Bar"],
      rows: [{ Foo: "x", Bar: "1" }],
    });
    expect(rows).toHaveLength(0);
    expect(errors[0].reason).toContain("product-name column");
  });

  test("missing every amount column is a whole-file rejection", () => {
    const { rows, errors } = normalizeProductImportRows({
      headers: ["Product Name", "HSN Code"],
      rows: [{ "Product Name": "x", "HSN Code": "1" }],
    });
    expect(rows).toHaveLength(0);
    expect(errors[0].reason).toContain("sales-amount column");
  });

  test("omitted Net/Tax columns are back-filled from Total", () => {
    const { rows, errors } = normalizeProductImportRows({
      headers: ["Product Name", "Product Count", "Total Sales"],
      rows: [{ "Product Name": "Serum", "Product Count": "2", "Total Sales": "1,000.00" }],
    });
    expect(errors).toEqual([]);
    expect(rows[0].totalSales).toBe(1000);
    expect(rows[0].netSales).toBe(1000); // tax column absent → 0 tax
    expect(rows[0].grossSales).toBe(1000);
  });
});

describe("a real vendor export round-trips", () => {
  const text = fs.readFileSync(
    path.join(FIXTURE_DIR, "product-sales-export-sample.csv"),
    "utf8",
  );
  const parsed = parseCsv(text);

  test("every product row parses, and the TOTAL row is not one of them", () => {
    const { rows, errors } = normalizeProductImportRows(parsed);
    expect(errors).toEqual([]);
    // 13 data lines in the fixture, one of which is the file's TOTAL row.
    expect(rows).toHaveLength(parsed.rows.length - 1);
    expect(rows.some((r) => r.productName === "Total")).toBe(false);
  });

  // The real check: our rollup of the product rows must reproduce the
  // amounts the vendor printed on its own TOTAL line. That line is dropped
  // during import precisely so this holds — if it were kept, every figure
  // here would be exactly double.
  test("summed product rows match the amounts on the file's own TOTAL row", () => {
    const { rows } = normalizeProductImportRows(parsed);
    const totals = sumProductTotals(rows);
    const totalLine = parsed.rows.find((r) =>
      isProductImportTotalsRow(r["Product Name"]),
    );
    expect(totalLine).toBeTruthy();
    expect(totals.productCount).toBe(parseImportMoney(totalLine["Product Count"]));
    near(totals.grossSales, parseImportMoney(totalLine["Gross Sales"]));
    near(totals.discount, parseImportMoney(totalLine.Discount));
    near(totals.netSales, parseImportMoney(totalLine["Net Sales"]));
    near(totals.tax, parseImportMoney(totalLine.Tax));
    near(totals.totalSales, parseImportMoney(totalLine["Total Sales"]));
  });

  test("the export's own per-row invariant (net + tax = total) survives parsing", () => {
    const { rows } = normalizeProductImportRows(parsed);
    for (const r of rows) near(r.netSales + r.tax, r.totalSales);
  });

  test("a fully-discounted row (total 0) is kept, not silently dropped", () => {
    const { rows } = normalizeProductImportRows(parsed);
    const zeroed = rows.find((r) => r.productName === "Sesderma C-Vit Liposomal Serum");
    expect(zeroed).toBeTruthy();
    expect(zeroed.totalSales).toBe(0);
    expect(zeroed.discount).toBe(5700);
  });
});

// ── The POS cutover ────────────────────────────────────────────────
//
// Once a clinic starts ringing product sales here, "live wins outright"
// silently drops the pre-cutover half of any window that straddles the
// boundary — an Aug→Sep view would show only September, reading as a
// catastrophic collapse. The two sources ARE addable, but only where their
// periods cannot describe the same sale.
describe("isBatchSafeToCombine", () => {
  const batch = (start, end) => ({ periodStart: start, periodEnd: end });

  test("no POS data at all → any snapshot is safe (nothing to collide with)", () => {
    expect(isBatchSafeToCombine(batch("2025-12-01", "2026-08-18"), null)).toBe(true);
    expect(isBatchSafeToCombine(batch("2025-12-01", "2026-08-18"), undefined)).toBe(true);
  });

  test("snapshot ending before the cutover is safe to add to POS", () => {
    expect(
      isBatchSafeToCombine(batch("2025-12-01", "2026-08-18T23:59:59Z"), "2026-09-05T10:00:00Z"),
    ).toBe(true);
  });

  test("snapshot reaching past the cutover is NOT safe — it may double-count", () => {
    expect(
      isBatchSafeToCombine(batch("2025-12-01", "2026-09-30T23:59:59Z"), "2026-09-05T10:00:00Z"),
    ).toBe(false);
  });

  test("a snapshot ending exactly at the cutover is excluded — the boundary is strict", () => {
    const t = "2026-09-05T10:00:00.000Z";
    expect(isBatchSafeToCombine(batch("2025-12-01", t), t)).toBe(false);
  });

  test("an unparseable period is excluded rather than risked", () => {
    expect(isBatchSafeToCombine(batch("2025-12-01", "not-a-date"), "2026-09-05T10:00:00Z")).toBe(false);
  });
});

describe("mergeProductRows", () => {
  const row = (key, over = {}) =>
    finalizeProductRow({
      key,
      productId: null,
      name: key,
      hsnCode: null,
      productCount: 1,
      grossSales: 100,
      discount: 0,
      netSales: 100,
      tax: 0,
      totalSales: 100,
      ...over,
    });

  test("sums every measure for a product present on both sides", () => {
    const merged = mergeProductRows(
      [row("p:1", { productCount: 2, grossSales: 200, totalSales: 200, netSales: 200 })],
      [row("p:1", { productCount: 3, grossSales: 300, totalSales: 300, netSales: 300 })],
    );
    expect(merged).toHaveLength(1);
    expect(merged[0].productCount).toBe(5);
    expect(merged[0].grossSales).toBe(500);
    expect(merged[0].totalSales).toBe(500);
    expect(merged[0].revenue).toBe(500);
  });

  test("keeps products that appear on only one side", () => {
    const merged = mergeProductRows([row("p:1")], [row("p:2")]);
    expect(merged.map((r) => r.key).sort()).toEqual(["p:1", "p:2"]);
  });

  test("fills in an HSN / productId the other side is missing", () => {
    const merged = mergeProductRows(
      [row("p:1", { hsnCode: null, productId: null })],
      [row("p:1", { hsnCode: "3304", productId: 9 })],
    );
    expect(merged[0].hsnCode).toBe("3304");
    expect(merged[0].productId).toBe(9);
  });

  test("the merged set still totals correctly", () => {
    const merged = mergeProductRows(
      [row("p:1", { totalSales: 2625, netSales: 2500, tax: 125, productCount: 1 })],
      [row("p:1", { totalSales: 2226819.92, netSales: 2122312.33, tax: 104507.71, productCount: 1248 })],
    );
    const totals = sumProductTotals(merged);
    expect(totals.productCount).toBe(1249);
    expect(totals.totalSales).toBeCloseTo(2229444.92, 2);
  });

  test("empty / missing inputs are tolerated", () => {
    expect(mergeProductRows([], [])).toEqual([]);
    expect(mergeProductRows(null, undefined)).toEqual([]);
  });
});
