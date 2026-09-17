// backend/routes/wellness.js — report EXPORTS must contain every row.
//
// The bug this pins:
//   The five /wellness/reports/* tabs each have .csv / .pdf / .xlsx siblings
//   that re-use the SAME compute helper as the JSON endpoint. That helper runs
//   paginateReportRows(), which caps at REPORT_PAGE_SIZE_DEFAULT = 10. The
//   exporters then appended a TOTAL row built from `result.totals` — computed
//   over the FULL set.
//
//   So an export of the P&L (149 services) shipped 10 rows under a total
//   covering all 149. The file looks authoritative and does not reconcile:
//   whoever sums the column in Excel is short by the other 139 rows. That is
//   worse than no export, because nothing on the page says it is a sample.
//
//   Fixed by making paginateReportRows() return the whole sorted set when the
//   request path ends in .csv / .pdf / .xlsx (isReportExportRequest). Detecting
//   by path rather than by a per-route flag means a future export sibling
//   cannot forget to opt in.
//
// What is pinned here
//   1. the JSON endpoint STILL paginates (10 rows + a cursor) — infinite
//      scroll on the page depends on it
//   2. the .csv export contains EVERY row, not one page
//   3. the exported rows RECONCILE against the export's own TOTAL row —
//      the property that actually broke
//   4. .xlsx and .pdf grow with the full set too
//   5. the same holds for a sibling report (pnl-by-service), because the fix
//      is central and must not be per-report
//
// The DB is stubbed, so this runs without MySQL.

import {
  describe,
  test,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
} from "vitest";
import { createRequire } from "node:module";
import Module from "node:module";
import path from "node:path";
import zlib from "node:zlib";

const requireCJS = createRequire(import.meta.url);

// ── Stub data ──────────────────────────────────────────────────────
// 25 products / 25 services — comfortably over the 10-row page size, so a
// paginated export is unmistakable.
const PRODUCT_COUNT = 25;
const SERVICE_COUNT = 25;

const products = Array.from({ length: PRODUCT_COUNT }, (_, i) => ({
  id: i + 1,
  tenantId: 1,
  name: `Product ${String(i + 1).padStart(2, "0")}`,
  sku: null,
  productCode: null,
  hsnCode: "3304",
  // 0% tax keeps the arithmetic exact so the reconciliation assertion is
  // about pagination, not about rounding.
  tax: 0,
  isTaxIncluded: false,
}));

const saleLineItems = products.map((p) => ({
  tenantId: 1,
  lineType: "PRODUCT",
  refId: p.id,
  name: p.name,
  quantity: 2,
  unitPrice: 100 * (p.id + 1),
  lineDiscount: 0,
}));

const services = Array.from({ length: SERVICE_COUNT }, (_, i) => ({
  id: i + 1,
  tenantId: 1,
  name: `Service ${String(i + 1).padStart(2, "0")}`,
  category: "Clinical",
  ticketTier: "medium",
  basePrice: 1000,
}));

const visits = services.map((s) => ({
  id: s.id,
  status: "completed",
  serviceId: s.id,
  amountCharged: 500 * (s.id + 1),
  doctorId: null,
}));

let reportSales = [];
let reportInvoices = [];
let invoiceFindManyArgs = [];

const prismaStub = {
  saleLineItem: {
    findMany: async () => saleLineItems,
    // The POS-cutover lookup. This fixture has no imported snapshot, so the
    // cutover is irrelevant here — null keeps the export suite purely live.
    findFirst: async () => null,
  },
  product: { findMany: async () => products },
  productSalesImport: { findMany: async () => [] },
  productSalesImportRow: { findMany: async () => [] },
  sale: { findMany: async () => reportSales },
  visit: { findMany: async () => visits },
  service: { findMany: async () => services },
  serviceConsumption: { findMany: async () => [] },
  location: { findMany: async () => [], findFirst: async () => null },
  user: { findMany: async () => [] },
  patient: { groupBy: async () => [], findMany: async () => [] },
  invoice: {
    findMany: async (args) => {
      invoiceFindManyArgs.push(args);
      return reportInvoices;
    },
  },
  expense: { findMany: async () => [] },
  contact: { findMany: async () => [] },
  tenant: {
    findUnique: async () => ({
      id: 1,
      vertical: "wellness",
      name: "Tenant Name Fallback",
      logoUrl: null,
      brandColor: "#C9A063",
      themeColor: "#265855",
      locale: "en-IN",
      ownerEmail: "owner@example.com",
    }),
  },
  tenantSetting: {
    findMany: async () => [
      { key: "invoice.brandName", value: "Configured Report Brand" },
      { key: "invoice.tagline", value: "Configured wellness care" },
      { key: "invoice.companyAddress", value: "Configured Report Address" },
      { key: "invoice.companyPhone", value: "+91 90000 00000" },
      { key: "invoice.companyEmail", value: "reports@example.com" },
      { key: "invoice.themeColor", value: "#2D6A5D" },
    ],
  },
  wellnessRoleType: { findMany: async () => [] },
};

// routes/wellness.js and middleware/wellnessRole.js are CommonJS and are
// pulled in with createRequire, which bypasses Vitest's module graph — so
// vi.mock() would never be consulted. Intercept at the CJS loader instead so
// every `require("../lib/prisma")` in the graph resolves to the stub. Without
// this the real client loads, has no DATABASE_URL under vitest, and the
// wellness-vertical gate fails closed with 403 on every request.
const PRISMA_MODULE = path
  .resolve(__dirname, "../../lib/prisma.js")
  .replace(/\\/g, "/");

let restoreLoader;
let app;
let request;

beforeAll(async () => {
  process.env.JWT_SECRET = process.env.JWT_SECRET || "x".repeat(40);

  const originalLoad = Module._load;
  restoreLoader = () => {
    Module._load = originalLoad;
  };
  Module._load = function patchedLoad(requestPath, parent, isMain) {
    if (parent && requestPath.includes("lib/prisma")) {
      let resolved = null;
      try {
        resolved = Module._resolveFilename(requestPath, parent, isMain);
      } catch {
        resolved = null;
      }
      if (resolved && resolved.replace(/\\/g, "/") === PRISMA_MODULE) {
        return prismaStub;
      }
    }
    return originalLoad.apply(this, arguments);
  };

  const express = requireCJS("express");
  request = requireCJS("supertest");
  const router = requireCJS("../../routes/wellness.js");
  app = express();
  app.use((req, _res, next) => {
    req.user = { userId: 1, tenantId: 1, role: "ADMIN", wellnessRole: "admin" };
    next();
  });
  app.use("/api/wellness", router);
});

afterAll(() => {
  if (restoreLoader) restoreLoader();
});

const WINDOW = "from=2026-01-01&to=2026-12-31";

beforeEach(() => {
  reportSales = [];
  reportInvoices = [];
  invoiceFindManyArgs = [];
});

function extractPdfText(buf) {
  const str = buf.toString("latin1");
  let allOps = "";
  const lengthRe = /\/Length\s+(\d+)\b[^>]*>>\s*stream\r?\n/g;
  let match;
  while ((match = lengthRe.exec(str)) !== null) {
    const length = parseInt(match[1], 10);
    const start = lengthRe.lastIndex;
    const raw = buf.subarray(start, start + length);
    try {
      allOps += zlib.inflateSync(raw).toString("latin1");
    } catch {
      allOps += raw.toString("latin1");
    }
  }
  let text = "";
  const arrayRe = /\[([^\]]*)\]\s*TJ/g;
  while ((match = arrayRe.exec(allOps)) !== null) {
    const hexRe = /<([0-9a-fA-F\s]+)>/g;
    let hexMatch;
    while ((hexMatch = hexRe.exec(match[1])) !== null) {
      const hex = hexMatch[1].replace(/\s+/g, "");
      for (let i = 0; i + 1 < hex.length; i += 2) {
        text += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16));
      }
    }
    text += " ";
  }
  const literalRe = /\(((?:[^()\\]|\\.)*)\)\s*Tj/g;
  while ((match = literalRe.exec(allOps)) !== null) {
    text += match[1].replace(/\\(.)/g, "$1") + " ";
  }
  return text;
}

function pdfPageCount(buf) {
  return (buf.toString("latin1").match(/\/Type\s*\/Page\b/g) || []).length;
}

// Split a CSV body into its data rows and its TOTAL row. Product/service names
// here contain no commas, so a naive split is safe for this fixture.
function readCsv(text) {
  const lines = text
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .filter((l) => l.trim() !== "");
  const header = lines[0];
  const totalLine = lines.find((l) => l.startsWith("TOTAL,"));
  const dataRows = lines.slice(1).filter((l) => !l.startsWith("TOTAL,"));
  return { header, dataRows, totalCells: totalLine ? totalLine.split(",") : null };
}

describe("report JSON endpoints still paginate", () => {
  test("per-product returns one 10-row page plus a cursor", async () => {
    const res = await request(app).get(`/api/wellness/reports/per-product?${WINDOW}`);
    expect(res.status).toBe(200);
    expect(res.body.rows).toHaveLength(10);
    expect(res.body.pagination.total).toBe(PRODUCT_COUNT);
    expect(res.body.pagination.hasMore).toBe(true);
    expect(typeof res.body.pagination.nextCursor).toBe("string");
  });

  test("pnl-by-service returns one 10-row page plus a cursor", async () => {
    const res = await request(app).get(`/api/wellness/reports/pnl-by-service?${WINDOW}`);
    expect(res.status).toBe(200);
    expect(res.body.rows).toHaveLength(10);
    expect(res.body.pagination.total).toBe(SERVICE_COUNT);
    expect(res.body.pagination.hasMore).toBe(true);
  });

  test("the cursor advances to a different page", async () => {
    const p1 = await request(app).get(`/api/wellness/reports/per-product?${WINDOW}`);
    const p2 = await request(app).get(
      `/api/wellness/reports/per-product?${WINDOW}&cursor=${encodeURIComponent(p1.body.pagination.nextCursor)}`,
    );
    expect(p2.status).toBe(200);
    expect(p2.body.rows).toHaveLength(10);
    expect(p2.body.rows[0].key).not.toBe(p1.body.rows[0].key);
  });
});

describe("additional wellness reports", () => {
  const reports = [
    { slug: "sales-by-customer", firstColumn: "Customer" },
    { slug: "product-summary", firstColumn: "Product" },
    { slug: "payments-by-mode", firstColumn: "Payment mode" },
    { slug: "expense-summary", firstColumn: "Category" },
  ];

  for (const report of reports) {
    test(`${report.slug} returns the standard JSON envelope`, async () => {
      const res = await request(app).get(`/api/wellness/reports/${report.slug}?${WINDOW}`);
      expect(res.status).toBe(200);
      expect(res.body.window).toHaveProperty("from");
      expect(res.body.window).toHaveProperty("to");
      expect(res.body.totals).toBeTruthy();
      expect(Array.isArray(res.body.rows)).toBe(true);
      expect(res.body.pagination).toHaveProperty("total");
    });

    test(`${report.slug} CSV uses the report-specific header`, async () => {
      const res = await request(app).get(`/api/wellness/reports/${report.slug}.csv?${WINDOW}`);
      expect(res.status).toBe(200);
      expect(res.text.replace(/^\uFEFF/, "").split(/\r?\n/)[0]).toContain(report.firstColumn);
      expect(res.headers["content-type"]).toContain("text/csv");
    });
  }

  test("payments-by-mode excludes credit sales, splits combined tenders, and filters invoices by paidAt", async () => {
    reportSales = [
      {
        id: 1,
        invoiceNumber: "POS-CREDIT",
        paidAmount: 0,
        paymentMethod: "PAYLATER",
        paymentBreakdownJson: null,
      },
      {
        id: 2,
        invoiceNumber: "POS-SPLIT",
        paidAmount: 500,
        paymentMethod: "COMBINED",
        paymentBreakdownJson: JSON.stringify([
          { method: "CASH", amount: 200 },
          { method: "CARD", amount: 300 },
        ]),
      },
    ];
    reportInvoices = [
      {
        id: 81,
        invoiceNum: "INV-PAID",
        amount: 700,
        status: "PAID",
        paidAt: new Date("2026-06-15T10:00:00.000Z"),
        paymentMode: "upi",
      },
    ];

    const res = await request(app).get(
      `/api/wellness/reports/payments-by-mode?${WINDOW}`,
    );

    expect(res.status).toBe(200);
    expect(res.body.totals).toMatchObject({
      transactions: 3,
      amount: 1200,
      posAmount: 500,
      invoiceAmount: 700,
    });
    expect(res.body.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "cash", amount: 200 }),
        expect.objectContaining({ id: "card", amount: 300 }),
        expect.objectContaining({ id: "upi", amount: 700 }),
      ]),
    );
    expect(res.body.rows).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "paylater" })]),
    );
    expect(invoiceFindManyArgs.at(-1).where).toEqual(
      expect.objectContaining({
        tenantId: 1,
        status: "PAID",
        paidAt: expect.objectContaining({
          gte: expect.any(Date),
          lte: expect.any(Date),
        }),
      }),
    );
    expect(invoiceFindManyArgs.at(-1).where).not.toHaveProperty("issuedDate");
  });
});

describe("report exports contain every row", () => {
  test("per-product.csv exports all rows, not one page", async () => {
    const res = await request(app).get(`/api/wellness/reports/per-product.csv?${WINDOW}`);
    expect(res.status).toBe(200);
    const { dataRows } = readCsv(res.text);
    expect(dataRows).toHaveLength(PRODUCT_COUNT);
  });

  test("pnl-by-service.csv exports all rows — the fix is central, not per-report", async () => {
    const res = await request(app).get(`/api/wellness/reports/pnl-by-service.csv?${WINDOW}`);
    expect(res.status).toBe(200);
    const { dataRows } = readCsv(res.text);
    expect(dataRows).toHaveLength(SERVICE_COUNT);
  });

  // The property that actually broke: an export whose rows do not add up to
  // its own printed total.
  test("per-product.csv rows RECONCILE against its own TOTAL row", async () => {
    const res = await request(app).get(`/api/wellness/reports/per-product.csv?${WINDOW}`);
    const { dataRows, totalCells } = readCsv(res.text);
    expect(totalCells).toBeTruthy();

    // Columns: Product Name, HSN, Count, Gross, Discount, Net, Tax, Total
    const summed = dataRows.reduce(
      (acc, line) => {
        const c = line.split(",");
        return {
          count: acc.count + Number(c[2]),
          gross: acc.gross + Number(c[3]),
          total: acc.total + Number(c[7]),
        };
      },
      { count: 0, gross: 0, total: 0 },
    );

    expect(summed.count).toBe(Number(totalCells[2]));
    expect(summed.gross).toBeCloseTo(Number(totalCells[3]), 2);
    expect(summed.total).toBeCloseTo(Number(totalCells[7]), 2);
  });

  test("pnl-by-service.csv rows RECONCILE against its own TOTAL row", async () => {
    const res = await request(app).get(`/api/wellness/reports/pnl-by-service.csv?${WINDOW}`);
    const { dataRows, totalCells } = readCsv(res.text);
    // Columns: Service, Category, Tier, Visits, Revenue, Product cost, Contribution
    const summedRevenue = dataRows.reduce((a, line) => a + Number(line.split(",")[4]), 0);
    expect(summedRevenue).toBeCloseTo(Number(totalCells[4]), 2);
  });

  test("xlsx and pdf exports carry the full set too", async () => {
    const xlsx = await request(app).get(`/api/wellness/reports/per-product.xlsx?${WINDOW}`);
    expect(xlsx.status).toBe(200);
    expect(xlsx.headers["content-type"]).toMatch(/spreadsheetml/);

    const pdf = await request(app).get(`/api/wellness/reports/per-product.pdf?${WINDOW}`);
    expect(pdf.status).toBe(200);
    expect(pdf.headers["content-type"]).toBe("application/pdf");
    expect(pdf.body.slice(0, 4).toString()).toBe("%PDF");
  });

  // An explicit ?limit on an export must not re-truncate it — the export
  // contract is "everything", independent of the paging query params the page
  // happens to send.
  test("PDF exports use tenant settings for the branded report header and footer", async () => {
    const pdf = await request(app).get(`/api/wellness/reports/product-summary.pdf?${WINDOW}`);
    expect(pdf.status).toBe(200);
    const text = extractPdfText(pdf.body);
    expect(text).toContain("Configured Report Brand");
    expect(text).toContain("Configured wellness care");
    expect(text).toContain("Configured Report Address");
    expect(text).toContain("Product Summary");
    expect(text).toContain("Reporting period");
    expect(text).toContain("Confidential business report");
    expect(text).toContain("TOTAL");
    expect(pdfPageCount(pdf.body)).toBeLessThanOrEqual(3);

    const perProduct = await request(app).get(`/api/wellness/reports/per-product.pdf?${WINDOW}`);
    expect(extractPdfText(perProduct.body)).toMatch(/Product\s+Count/);
  });

  test("every report tab has a branded PDF export endpoint", async () => {
    const pdfReports = [
      "pnl-by-service",
      "per-professional",
      "per-product",
      "sales-by-customer",
      "product-summary",
      "payments-by-mode",
      "expense-summary",
      "per-location",
      "attribution",
    ];
    for (const slug of pdfReports) {
      const pdf = await request(app).get(`/api/wellness/reports/${slug}.pdf?${WINDOW}`);
      expect(pdf.status, slug).toBe(200);
      expect(pdf.headers["content-type"], slug).toBe("application/pdf");
      expect(pdf.body.slice(0, 4).toString(), slug).toBe("%PDF");
    }
  });

  test("an explicit ?limit does not truncate an export", async () => {
    const res = await request(app).get(
      `/api/wellness/reports/per-product.csv?${WINDOW}&limit=5`,
    );
    const { dataRows } = readCsv(res.text);
    expect(dataRows).toHaveLength(PRODUCT_COUNT);
  });
});

// ── The POS cutover, at the route level ────────────────────────────
//
// The unit tests pin isBatchSafeToCombine / mergeProductRows. This pins the
// behaviour they exist for: a window straddling the day POS went live must
// report BOTH halves. Before the fix, "live wins outright" returned only the
// POS side, so an Aug→Sep view of a clinic that started POS in September
// showed September alone — a 99% apparent collapse in product sales.
describe("per-product across the POS cutover", () => {
  const IMPORT_TOTAL = 2226819.92;
  const POS_AT = new Date("2026-09-05T10:00:00.000Z");

  // A second app whose stub has BOTH an imported snapshot (Dec→18 Aug) and a
  // POS sale (5 Sep). Built here rather than in the shared stub so the export
  // suite above keeps its simple single-source fixture.
  let straddleApp;

  beforeAll(() => {
    const express = requireCJS("express");
    const posLine = {
      tenantId: 1,
      lineType: "PRODUCT",
      refId: 1,
      name: "Product 01",
      quantity: 1,
      unitPrice: 2625,
      lineDiscount: 0,
      sale: { status: "COMPLETED", createdAt: POS_AT },
    };
    const batch = {
      id: 2,
      fileName: "snapshot.csv",
      periodStart: new Date("2025-12-01T00:00:00.000Z"),
      periodEnd: new Date("2026-08-18T23:59:59.999Z"),
      createdAt: new Date("2026-08-26T00:00:00.000Z"),
    };
    const within = (v, f) => {
      if (!f) return true;
      const t = new Date(v).getTime();
      if (f.gte !== undefined && t < new Date(f.gte).getTime()) return false;
      if (f.lte !== undefined && t > new Date(f.lte).getTime()) return false;
      return true;
    };
    Object.assign(prismaStub, {
      saleLineItem: {
        findMany: async ({ where }) =>
          within(posLine.sale.createdAt, where.sale.createdAt) ? [posLine] : [],
        findFirst: async () => ({ sale: { createdAt: POS_AT } }),
      },
      product: {
        findMany: async () => [
          { id: 1, tenantId: 1, name: "Product 01", hsnCode: null, tax: 0, isTaxIncluded: false, sku: null, productCode: null },
        ],
      },
      productSalesImport: {
        findMany: async ({ where }) => {
          const okStart = !where.periodStart || batch.periodStart <= new Date(where.periodStart.lte);
          const okEnd = !where.periodEnd || batch.periodEnd >= new Date(where.periodEnd.gte);
          return okStart && okEnd ? [batch] : [];
        },
      },
      productSalesImportRow: {
        findMany: async () => [
          {
            productId: 1, productName: "Product 01", hsnCode: null,
            productCount: 1248, grossSales: 2321176, discount: 94356.19,
            netSales: 2122312.33, tax: 104507.71, totalSales: IMPORT_TOTAL,
          },
        ],
      },
    });
    const router = requireCJS("../../routes/wellness.js");
    straddleApp = express();
    straddleApp.use((req, _res, next) => {
      req.user = { userId: 1, tenantId: 1, role: "ADMIN", wellnessRole: "admin" };
      next();
    });
    straddleApp.use("/api/wellness", router);
  });

  const get = (from, to, extra = "") =>
    request(straddleApp).get(`/api/wellness/reports/per-product?from=${from}&to=${to}${extra}`);

  test("a window wholly inside the snapshot reports the snapshot", async () => {
    const res = await get("2026-01-01", "2026-06-30");
    expect(res.body.source).toBe("import");
    expect(res.body.totals.totalSales).toBeCloseTo(IMPORT_TOTAL, 2);
  });

  test("a window wholly after go-live reports POS only", async () => {
    const res = await get("2026-09-01", "2026-09-30");
    expect(res.body.source).toBe("live");
    expect(res.body.totals.totalSales).toBeCloseTo(2625, 2);
  });

  test("a STRADDLING window reports both halves, added", async () => {
    const res = await get("2026-08-01", "2026-09-30");
    expect(res.body.source).toBe("mixed");
    expect(res.body.totals.totalSales).toBeCloseTo(IMPORT_TOTAL + 2625, 2);
    // The snapshot's units and POS's unit are both counted.
    expect(res.body.totals.productCount).toBe(1249);
  });

  test("the response names the cutover so the page can explain itself", async () => {
    const res = await get("2026-08-01", "2026-09-30");
    expect(new Date(res.body.posCutoverAt).toISOString()).toBe(POS_AT.toISOString());
    expect(res.body.importBatches.map((b) => b.fileName)).toEqual(["snapshot.csv"]);
  });

  test("?source=live and ?source=import still return one source only", async () => {
    const live = await get("2026-08-01", "2026-09-30", "&source=live");
    expect(live.body.source).toBe("live");
    expect(live.body.totals.totalSales).toBeCloseTo(2625, 2);

    const imported = await get("2026-08-01", "2026-09-30", "&source=import");
    expect(imported.body.source).toBe("import");
    expect(imported.body.totals.totalSales).toBeCloseTo(IMPORT_TOTAL, 2);
  });

  test("a straddling export also carries both halves", async () => {
    const res = await request(straddleApp).get(
      "/api/wellness/reports/per-product.csv?from=2026-08-01&to=2026-09-30",
    );
    const { dataRows, totalCells } = readCsv(res.text);
    expect(dataRows).toHaveLength(1); // one product, merged from both sources
    expect(Number(totalCells[7])).toBeCloseTo(IMPORT_TOTAL + 2625, 2);
  });
});
