// @ts-check
/**
 * PRD_TRAVEL_SUPPLIER_MASTER G044 + G046 (FR-3.3.c, FR-3.4.a-c) —
 * Supplier-statement reconciliation + invoice-upload route surface tests.
 *
 * What's pinned
 * -------------
 *   - POST   /suppliers/:id/reconciliation-batches
 *       missing statementMonth → 400 MISSING_FIELDS
 *       bad statementMonth shape → 400 INVALID_STATEMENT_MONTH
 *       USER role → 403
 *       happy path → 201 + status=draft
 *       cross-tenant parent → 404 SUPPLIER_NOT_FOUND
 *   - GET    /suppliers/:id/reconciliation-batches
 *       happy path returns scoped list
 *       bad status filter → 400 INVALID_STATUS
 *   - GET    /suppliers/:id/reconciliation-batches/:batchId
 *       happy path returns batch + lines
 *       cross-tenant batch → 404 BATCH_NOT_FOUND
 *   - POST   /suppliers/:id/reconciliation-batches/:batchId/lines/bulk
 *       missing lines[] → 400 MISSING_FIELDS
 *       too many lines → 413 TOO_MANY_LINES
 *       negative supplierAmount → 400 INVALID_AMOUNT
 *       happy path → 201 + count
 *       on a reconciled batch → 409 BATCH_FINAL
 *   - POST   /suppliers/:id/reconciliation-batches/:batchId/auto-match
 *       happy path uses matchLines + writes decisions
 *       no unmatched lines → 200 with attempted=0
 *   - POST   /suppliers/:id/reconciliation-batches/:batchId/lines/:lineId/manual-match
 *       missing both poLineId AND payableId → 400 MISSING_FIELDS
 *       cross-tenant poLineId → 404 POLINE_NOT_FOUND
 *       cross-tenant payableId → 404 PAYABLE_NOT_FOUND
 *       happy path → 200 + matchStatus=manual_matched
 *   - POST   .../review + /reconcile + /dispute
 *       wrong source status → 409 INVALID_STATUS_TRANSITION
 *       /reconcile MANAGER role → 403 (ADMIN only)
 *   - POST   /suppliers/:id/invoice-uploads/:uploadId/match
 *       cross-tenant payable → 404 PAYABLE_NOT_FOUND
 *       happy path → 200 + matchStatus=matched
 *   - DELETE /suppliers/:id/invoice-uploads/:uploadId
 *       MANAGER role → 403 (ADMIN only)
 *       happy path → 200
 *
 * Pattern mirrors backend/test/routes/travel-supplier-commissions.test.js.
 */

import { describe, test, expect, beforeEach, vi } from "vitest";
import prisma from "../../lib/prisma.js";

prisma.travelSupplier = prisma.travelSupplier || {};
prisma.travelSupplier.findFirst = vi.fn();
prisma.travelSupplierReconciliationBatch = {
  findFirst: vi.fn(),
  findMany: vi.fn(),
  count: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
};
prisma.travelSupplierReconciliationLine = {
  findFirst: vi.fn(),
  findMany: vi.fn(),
  createMany: vi.fn(),
  update: vi.fn(),
};
prisma.travelSupplierInvoiceUpload = {
  findFirst: vi.fn(),
  findMany: vi.fn(),
  count: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
};
prisma.travelPurchaseOrderLine = prisma.travelPurchaseOrderLine || {};
prisma.travelPurchaseOrderLine.findMany = vi.fn();
prisma.travelPurchaseOrderLine.findFirst = vi.fn();
prisma.travelSupplierPayable = prisma.travelSupplierPayable || {};
prisma.travelSupplierPayable.findFirst = vi.fn();
prisma.tenant = prisma.tenant || {};
prisma.tenant.findUnique = vi.fn().mockResolvedValue({
  id: 1,
  vertical: "travel",
  name: "Test Travel",
  slug: "test-travel",
});
prisma.user = prisma.user || {};
prisma.user.findUnique = vi
  .fn()
  .mockResolvedValue({ role: "ADMIN", subBrandAccess: null });
prisma.auditLog = {
  ...(prisma.auditLog || {}),
  create: vi.fn().mockResolvedValue({ id: 1 }),
  findFirst: vi.fn().mockResolvedValue(null),
};
prisma.revokedToken = prisma.revokedToken || {};
prisma.revokedToken.findUnique = vi.fn().mockResolvedValue(null);
prisma.$transaction = vi.fn().mockImplementation(async (calls) =>
  Promise.all(Array.isArray(calls) ? calls : [calls]),
);

import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import { createRequire } from "node:module";

const requireCJS = createRequire(import.meta.url);
const JWT_SECRET = process.env.JWT_SECRET || "enterprise_super_secret_key_2026";
const router = requireCJS("../../routes/travel_supplier_reconciliation");

function makeApp() {
  const app = express();
  // Match server.js limit so the 5000-line cap test exercises the route's
  // own guard, not express.json's default 100kb body cap.
  app.use(express.json({ limit: "10mb" }));
  app.use("/api/travel", router);
  return app;
}

function tokenFor(role = "ADMIN", { userId = 7, tenantId = 1 } = {}) {
  return jwt.sign(
    { userId, tenantId, role, email: `${role.toLowerCase()}@test.local` },
    JWT_SECRET,
    { expiresIn: "1h" },
  );
}

const PARENT_SUPPLIER = {
  id: 100,
  tenantId: 1,
  subBrand: "tmc",
  name: "Air India",
  supplierCategory: "flight",
  isActive: true,
};

const DRAFT_BATCH = {
  id: 200,
  tenantId: 1,
  supplierId: 100,
  statementMonth: "2026-05",
  totalSupplierAmount: "0",
  totalOursAmount: "0",
  tolerancePct: "1",
  status: "draft",
};

beforeEach(() => {
  // Reset every mock between tests.
  for (const m of [
    prisma.travelSupplier.findFirst,
    prisma.travelSupplierReconciliationBatch.findFirst,
    prisma.travelSupplierReconciliationBatch.findMany,
    prisma.travelSupplierReconciliationBatch.count,
    prisma.travelSupplierReconciliationBatch.create,
    prisma.travelSupplierReconciliationBatch.update,
    prisma.travelSupplierReconciliationLine.findFirst,
    prisma.travelSupplierReconciliationLine.findMany,
    prisma.travelSupplierReconciliationLine.createMany,
    prisma.travelSupplierReconciliationLine.update,
    prisma.travelSupplierInvoiceUpload.findFirst,
    prisma.travelSupplierInvoiceUpload.findMany,
    prisma.travelSupplierInvoiceUpload.count,
    prisma.travelSupplierInvoiceUpload.create,
    prisma.travelSupplierInvoiceUpload.update,
    prisma.travelSupplierInvoiceUpload.delete,
    prisma.travelPurchaseOrderLine.findMany,
    prisma.travelPurchaseOrderLine.findFirst,
    prisma.travelSupplierPayable.findFirst,
  ]) {
    m.mockReset();
  }
  prisma.tenant.findUnique.mockReset().mockResolvedValue({
    id: 1,
    vertical: "travel",
    name: "Test Travel",
    slug: "test-travel",
  });
  prisma.user.findUnique
    .mockReset()
    .mockResolvedValue({ role: "ADMIN", subBrandAccess: null });
  prisma.auditLog.create.mockReset().mockResolvedValue({ id: 1 });
  prisma.auditLog.findFirst.mockReset().mockResolvedValue(null);
  prisma.$transaction.mockImplementation(async (calls) =>
    Promise.all(Array.isArray(calls) ? calls : [calls]),
  );
});

// ─── POST /reconciliation-batches ─────────────────────────────────────

describe("POST /api/travel/suppliers/:id/reconciliation-batches", () => {
  test("happy path → 201 with status=draft", async () => {
    prisma.travelSupplier.findFirst.mockResolvedValue(PARENT_SUPPLIER);
    prisma.travelSupplierReconciliationBatch.create.mockResolvedValue({
      ...DRAFT_BATCH,
      id: 201,
    });
    const res = await request(makeApp())
      .post("/api/travel/suppliers/100/reconciliation-batches")
      .set("Authorization", `Bearer ${tokenFor("ADMIN")}`)
      .send({ statementMonth: "2026-05", tolerancePct: 1.5 });
    expect(res.status, `create: ${res.text}`).toBe(201);
    expect(res.body.id).toBe(201);
    expect(prisma.travelSupplierReconciliationBatch.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          tenantId: 1,
          supplierId: 100,
          statementMonth: "2026-05",
          tolerancePct: "1.5",
          status: "draft",
        }),
      }),
    );
  });

  test("missing statementMonth → 400 MISSING_FIELDS", async () => {
    prisma.travelSupplier.findFirst.mockResolvedValue(PARENT_SUPPLIER);
    const res = await request(makeApp())
      .post("/api/travel/suppliers/100/reconciliation-batches")
      .set("Authorization", `Bearer ${tokenFor("ADMIN")}`)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("MISSING_FIELDS");
  });

  test("bad statementMonth shape → 400 INVALID_STATEMENT_MONTH", async () => {
    prisma.travelSupplier.findFirst.mockResolvedValue(PARENT_SUPPLIER);
    const res = await request(makeApp())
      .post("/api/travel/suppliers/100/reconciliation-batches")
      .set("Authorization", `Bearer ${tokenFor("ADMIN")}`)
      .send({ statementMonth: "2026-13" });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("INVALID_STATEMENT_MONTH");
  });

  test("tolerance > 100 → 400 INVALID_TOLERANCE", async () => {
    prisma.travelSupplier.findFirst.mockResolvedValue(PARENT_SUPPLIER);
    const res = await request(makeApp())
      .post("/api/travel/suppliers/100/reconciliation-batches")
      .set("Authorization", `Bearer ${tokenFor("ADMIN")}`)
      .send({ statementMonth: "2026-05", tolerancePct: 150 });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("INVALID_TOLERANCE");
  });

  test("USER role → 403", async () => {
    const res = await request(makeApp())
      .post("/api/travel/suppliers/100/reconciliation-batches")
      .set("Authorization", `Bearer ${tokenFor("USER")}`)
      .send({ statementMonth: "2026-05" });
    expect(res.status).toBe(403);
    expect(
      prisma.travelSupplierReconciliationBatch.create,
    ).not.toHaveBeenCalled();
  });

  test("cross-tenant parent → 404 SUPPLIER_NOT_FOUND", async () => {
    prisma.travelSupplier.findFirst.mockResolvedValue(null);
    const res = await request(makeApp())
      .post("/api/travel/suppliers/9999/reconciliation-batches")
      .set("Authorization", `Bearer ${tokenFor("ADMIN")}`)
      .send({ statementMonth: "2026-05" });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe("SUPPLIER_NOT_FOUND");
  });
});

// ─── GET /reconciliation-batches ──────────────────────────────────────

describe("GET /api/travel/suppliers/:id/reconciliation-batches", () => {
  test("happy path returns scoped list + total", async () => {
    prisma.travelSupplier.findFirst.mockResolvedValue(PARENT_SUPPLIER);
    prisma.travelSupplierReconciliationBatch.findMany.mockResolvedValue([
      DRAFT_BATCH,
    ]);
    prisma.travelSupplierReconciliationBatch.count.mockResolvedValue(1);
    const res = await request(makeApp())
      .get("/api/travel/suppliers/100/reconciliation-batches")
      .set("Authorization", `Bearer ${tokenFor("ADMIN")}`);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.batches).toHaveLength(1);
  });

  test("?status=foo → 400 INVALID_STATUS", async () => {
    prisma.travelSupplier.findFirst.mockResolvedValue(PARENT_SUPPLIER);
    const res = await request(makeApp())
      .get("/api/travel/suppliers/100/reconciliation-batches?status=foo")
      .set("Authorization", `Bearer ${tokenFor("ADMIN")}`);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("INVALID_STATUS");
  });
});

// ─── GET batch detail ──────────────────────────────────────────────────

describe("GET batch detail", () => {
  test("happy path returns batch + lines", async () => {
    prisma.travelSupplier.findFirst.mockResolvedValue(PARENT_SUPPLIER);
    prisma.travelSupplierReconciliationBatch.findFirst.mockResolvedValue(
      DRAFT_BATCH,
    );
    prisma.travelSupplierReconciliationLine.findMany.mockResolvedValue([
      {
        id: 1,
        batchId: 200,
        pnr: "P1",
        supplierAmount: "1000.00",
        matchStatus: "unmatched",
      },
    ]);
    const res = await request(makeApp())
      .get("/api/travel/suppliers/100/reconciliation-batches/200")
      .set("Authorization", `Bearer ${tokenFor("ADMIN")}`);
    expect(res.status).toBe(200);
    expect(res.body.batch.id).toBe(200);
    expect(res.body.lines).toHaveLength(1);
  });

  test("cross-tenant batch → 404 BATCH_NOT_FOUND", async () => {
    prisma.travelSupplier.findFirst.mockResolvedValue(PARENT_SUPPLIER);
    prisma.travelSupplierReconciliationBatch.findFirst.mockResolvedValue(null);
    const res = await request(makeApp())
      .get("/api/travel/suppliers/100/reconciliation-batches/9999")
      .set("Authorization", `Bearer ${tokenFor("ADMIN")}`);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe("BATCH_NOT_FOUND");
  });
});

// ─── POST /lines/bulk ──────────────────────────────────────────────────

describe("POST /lines/bulk", () => {
  test("missing lines[] → 400 MISSING_FIELDS", async () => {
    prisma.travelSupplier.findFirst.mockResolvedValue(PARENT_SUPPLIER);
    prisma.travelSupplierReconciliationBatch.findFirst.mockResolvedValue(
      DRAFT_BATCH,
    );
    const res = await request(makeApp())
      .post("/api/travel/suppliers/100/reconciliation-batches/200/lines/bulk")
      .set("Authorization", `Bearer ${tokenFor("ADMIN")}`)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("MISSING_FIELDS");
  });

  test("too many lines → 413 TOO_MANY_LINES", async () => {
    prisma.travelSupplier.findFirst.mockResolvedValue(PARENT_SUPPLIER);
    prisma.travelSupplierReconciliationBatch.findFirst.mockResolvedValue(
      DRAFT_BATCH,
    );
    const lines = Array.from({ length: 5001 }, (_, i) => ({
      pnr: `P${i}`,
      supplierAmount: 100,
    }));
    const res = await request(makeApp())
      .post("/api/travel/suppliers/100/reconciliation-batches/200/lines/bulk")
      .set("Authorization", `Bearer ${tokenFor("ADMIN")}`)
      .send({ lines });
    expect(res.status).toBe(413);
    expect(res.body.code).toBe("TOO_MANY_LINES");
  });

  test("negative supplierAmount → 400 INVALID_AMOUNT", async () => {
    prisma.travelSupplier.findFirst.mockResolvedValue(PARENT_SUPPLIER);
    prisma.travelSupplierReconciliationBatch.findFirst.mockResolvedValue(
      DRAFT_BATCH,
    );
    const res = await request(makeApp())
      .post("/api/travel/suppliers/100/reconciliation-batches/200/lines/bulk")
      .set("Authorization", `Bearer ${tokenFor("ADMIN")}`)
      .send({ lines: [{ pnr: "P1", supplierAmount: -50 }] });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("INVALID_AMOUNT");
  });

  test("happy path → 201 + count", async () => {
    prisma.travelSupplier.findFirst.mockResolvedValue(PARENT_SUPPLIER);
    prisma.travelSupplierReconciliationBatch.findFirst.mockResolvedValue(
      DRAFT_BATCH,
    );
    prisma.travelSupplierReconciliationLine.createMany.mockResolvedValue({
      count: 2,
    });
    prisma.travelSupplierReconciliationBatch.update.mockResolvedValue({
      ...DRAFT_BATCH,
      totalSupplierAmount: "300",
    });
    const res = await request(makeApp())
      .post("/api/travel/suppliers/100/reconciliation-batches/200/lines/bulk")
      .set("Authorization", `Bearer ${tokenFor("ADMIN")}`)
      .send({
        lines: [
          { pnr: "P1", supplierAmount: 100 },
          { pnr: "P2", supplierAmount: 200 },
        ],
      });
    expect(res.status, `bulk: ${res.text}`).toBe(201);
    expect(res.body.added).toBe(2);
  });

  test("on reconciled batch → 409 BATCH_FINAL", async () => {
    prisma.travelSupplier.findFirst.mockResolvedValue(PARENT_SUPPLIER);
    prisma.travelSupplierReconciliationBatch.findFirst.mockResolvedValue({
      ...DRAFT_BATCH,
      status: "reconciled",
    });
    const res = await request(makeApp())
      .post("/api/travel/suppliers/100/reconciliation-batches/200/lines/bulk")
      .set("Authorization", `Bearer ${tokenFor("ADMIN")}`)
      .send({ lines: [{ pnr: "P1", supplierAmount: 100 }] });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("BATCH_FINAL");
  });
});

// ─── POST /auto-match ──────────────────────────────────────────────────

describe("POST /auto-match", () => {
  test("no unmatched lines → 200 attempted=0", async () => {
    prisma.travelSupplier.findFirst.mockResolvedValue(PARENT_SUPPLIER);
    prisma.travelSupplierReconciliationBatch.findFirst.mockResolvedValue(
      DRAFT_BATCH,
    );
    prisma.travelSupplierReconciliationLine.findMany.mockResolvedValue([]);
    const res = await request(makeApp())
      .post("/api/travel/suppliers/100/reconciliation-batches/200/auto-match")
      .set("Authorization", `Bearer ${tokenFor("ADMIN")}`)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.attempted).toBe(0);
    expect(res.body.autoMatched).toBe(0);
  });

  test("happy path runs matcher + updates lines + returns counts", async () => {
    prisma.travelSupplier.findFirst.mockResolvedValue(PARENT_SUPPLIER);
    prisma.travelSupplierReconciliationBatch.findFirst.mockResolvedValue(
      DRAFT_BATCH,
    );
    // unmatched line on first findMany call.
    prisma.travelSupplierReconciliationLine.findMany
      .mockResolvedValueOnce([
        { id: 11, pnr: "P1", supplierAmount: "1000" },
      ])
      .mockResolvedValueOnce([{ matchedPoLineId: 99 }]);
    prisma.travelPurchaseOrderLine.findMany
      .mockResolvedValueOnce([{ id: 99, pnr: "P1", lineTotal: "1000" }])
      .mockResolvedValueOnce([{ lineTotal: "1000" }]);
    prisma.travelSupplierReconciliationLine.update.mockResolvedValue({
      id: 11,
      matchStatus: "auto_matched",
    });
    prisma.travelSupplierReconciliationBatch.update.mockResolvedValue(
      DRAFT_BATCH,
    );

    const res = await request(makeApp())
      .post("/api/travel/suppliers/100/reconciliation-batches/200/auto-match")
      .set("Authorization", `Bearer ${tokenFor("ADMIN")}`)
      .send({});
    expect(res.status, `auto: ${res.text}`).toBe(200);
    expect(res.body.attempted).toBe(1);
    expect(res.body.autoMatched).toBe(1);
  });

  test("batch reconciled → 409 BATCH_FINAL", async () => {
    prisma.travelSupplier.findFirst.mockResolvedValue(PARENT_SUPPLIER);
    prisma.travelSupplierReconciliationBatch.findFirst.mockResolvedValue({
      ...DRAFT_BATCH,
      status: "reconciled",
    });
    const res = await request(makeApp())
      .post("/api/travel/suppliers/100/reconciliation-batches/200/auto-match")
      .set("Authorization", `Bearer ${tokenFor("ADMIN")}`)
      .send({});
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("BATCH_FINAL");
  });
});

// ─── POST /manual-match ────────────────────────────────────────────────

describe("POST /lines/:lineId/manual-match", () => {
  test("missing poLineId AND payableId → 400 MISSING_FIELDS", async () => {
    prisma.travelSupplier.findFirst.mockResolvedValue(PARENT_SUPPLIER);
    prisma.travelSupplierReconciliationBatch.findFirst.mockResolvedValue(
      DRAFT_BATCH,
    );
    const res = await request(makeApp())
      .post(
        "/api/travel/suppliers/100/reconciliation-batches/200/lines/11/manual-match",
      )
      .set("Authorization", `Bearer ${tokenFor("ADMIN")}`)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("MISSING_FIELDS");
  });

  test("cross-tenant poLineId → 404 POLINE_NOT_FOUND", async () => {
    prisma.travelSupplier.findFirst.mockResolvedValue(PARENT_SUPPLIER);
    prisma.travelSupplierReconciliationBatch.findFirst.mockResolvedValue(
      DRAFT_BATCH,
    );
    prisma.travelSupplierReconciliationLine.findFirst.mockResolvedValue({
      id: 11,
      tenantId: 1,
      batchId: 200,
      supplierAmount: "1000",
    });
    prisma.travelPurchaseOrderLine.findFirst.mockResolvedValue(null);
    const res = await request(makeApp())
      .post(
        "/api/travel/suppliers/100/reconciliation-batches/200/lines/11/manual-match",
      )
      .set("Authorization", `Bearer ${tokenFor("ADMIN")}`)
      .send({ poLineId: 9999 });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe("POLINE_NOT_FOUND");
  });

  test("cross-tenant payableId → 404 PAYABLE_NOT_FOUND", async () => {
    prisma.travelSupplier.findFirst.mockResolvedValue(PARENT_SUPPLIER);
    prisma.travelSupplierReconciliationBatch.findFirst.mockResolvedValue(
      DRAFT_BATCH,
    );
    prisma.travelSupplierReconciliationLine.findFirst.mockResolvedValue({
      id: 11,
      tenantId: 1,
      batchId: 200,
      supplierAmount: "1000",
    });
    prisma.travelSupplierPayable.findFirst.mockResolvedValue(null);
    const res = await request(makeApp())
      .post(
        "/api/travel/suppliers/100/reconciliation-batches/200/lines/11/manual-match",
      )
      .set("Authorization", `Bearer ${tokenFor("ADMIN")}`)
      .send({ payableId: 9999 });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe("PAYABLE_NOT_FOUND");
  });

  test("happy path → 200 + matchStatus=manual_matched + variance", async () => {
    prisma.travelSupplier.findFirst.mockResolvedValue(PARENT_SUPPLIER);
    prisma.travelSupplierReconciliationBatch.findFirst.mockResolvedValue(
      DRAFT_BATCH,
    );
    prisma.travelSupplierReconciliationLine.findFirst.mockResolvedValue({
      id: 11,
      tenantId: 1,
      batchId: 200,
      supplierAmount: "1000",
    });
    prisma.travelPurchaseOrderLine.findFirst.mockResolvedValue({
      id: 99,
      lineTotal: "990",
    });
    prisma.travelSupplierReconciliationLine.update.mockResolvedValue({
      id: 11,
      matchStatus: "manual_matched",
      matchedPoLineId: 99,
      varianceAmount: "10",
    });
    const res = await request(makeApp())
      .post(
        "/api/travel/suppliers/100/reconciliation-batches/200/lines/11/manual-match",
      )
      .set("Authorization", `Bearer ${tokenFor("ADMIN")}`)
      .send({ poLineId: 99 });
    expect(res.status, `manual: ${res.text}`).toBe(200);
    expect(res.body.matchStatus).toBe("manual_matched");
    expect(
      prisma.travelSupplierReconciliationLine.update,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          matchStatus: "manual_matched",
          matchedPoLineId: 99,
          varianceAmount: "10",
        }),
      }),
    );
  });
});

// ─── State transitions ──────────────────────────────────────────────────

describe("state transitions: review / reconcile / dispute", () => {
  test("review draft → reviewed", async () => {
    prisma.travelSupplier.findFirst.mockResolvedValue(PARENT_SUPPLIER);
    prisma.travelSupplierReconciliationBatch.findFirst.mockResolvedValue(
      DRAFT_BATCH,
    );
    prisma.travelSupplierReconciliationBatch.update.mockResolvedValue({
      ...DRAFT_BATCH,
      status: "reviewed",
    });
    const res = await request(makeApp())
      .post("/api/travel/suppliers/100/reconciliation-batches/200/review")
      .set("Authorization", `Bearer ${tokenFor("ADMIN")}`)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("reviewed");
  });

  test("review on already-reviewed → 409 INVALID_STATUS_TRANSITION", async () => {
    prisma.travelSupplier.findFirst.mockResolvedValue(PARENT_SUPPLIER);
    prisma.travelSupplierReconciliationBatch.findFirst.mockResolvedValue({
      ...DRAFT_BATCH,
      status: "reviewed",
    });
    const res = await request(makeApp())
      .post("/api/travel/suppliers/100/reconciliation-batches/200/review")
      .set("Authorization", `Bearer ${tokenFor("ADMIN")}`)
      .send({});
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("INVALID_STATUS_TRANSITION");
  });

  test("reconcile from draft → 409 (must be reviewed first)", async () => {
    prisma.travelSupplier.findFirst.mockResolvedValue(PARENT_SUPPLIER);
    prisma.travelSupplierReconciliationBatch.findFirst.mockResolvedValue(
      DRAFT_BATCH,
    );
    const res = await request(makeApp())
      .post("/api/travel/suppliers/100/reconciliation-batches/200/reconcile")
      .set("Authorization", `Bearer ${tokenFor("ADMIN")}`)
      .send({});
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("INVALID_STATUS_TRANSITION");
  });

  test("reconcile MANAGER role → 403 (ADMIN-only)", async () => {
    const res = await request(makeApp())
      .post("/api/travel/suppliers/100/reconciliation-batches/200/reconcile")
      .set("Authorization", `Bearer ${tokenFor("MANAGER")}`)
      .send({});
    expect(res.status).toBe(403);
  });

  test("dispute from draft → 200 disputed", async () => {
    prisma.travelSupplier.findFirst.mockResolvedValue(PARENT_SUPPLIER);
    prisma.travelSupplierReconciliationBatch.findFirst.mockResolvedValue(
      DRAFT_BATCH,
    );
    prisma.travelSupplierReconciliationBatch.update.mockResolvedValue({
      ...DRAFT_BATCH,
      status: "disputed",
    });
    const res = await request(makeApp())
      .post("/api/travel/suppliers/100/reconciliation-batches/200/dispute")
      .set("Authorization", `Bearer ${tokenFor("ADMIN")}`)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("disputed");
  });
});

// ─── Invoice uploads — match + delete (POST/DELETE without multer file) ─

describe("invoice-uploads match + delete", () => {
  test("match cross-tenant payable → 404 PAYABLE_NOT_FOUND", async () => {
    prisma.travelSupplier.findFirst.mockResolvedValue(PARENT_SUPPLIER);
    prisma.travelSupplierInvoiceUpload.findFirst.mockResolvedValue({
      id: 500,
      tenantId: 1,
      supplierId: 100,
    });
    prisma.travelSupplierPayable.findFirst.mockResolvedValue(null);
    const res = await request(makeApp())
      .post("/api/travel/suppliers/100/invoice-uploads/500/match")
      .set("Authorization", `Bearer ${tokenFor("ADMIN")}`)
      .send({ payableId: 9999 });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe("PAYABLE_NOT_FOUND");
  });

  test("match happy path → matchStatus=matched", async () => {
    prisma.travelSupplier.findFirst.mockResolvedValue(PARENT_SUPPLIER);
    prisma.travelSupplierInvoiceUpload.findFirst.mockResolvedValue({
      id: 500,
      tenantId: 1,
      supplierId: 100,
    });
    prisma.travelSupplierPayable.findFirst.mockResolvedValue({ id: 700 });
    prisma.travelSupplierInvoiceUpload.update.mockResolvedValue({
      id: 500,
      matchStatus: "matched",
      payableId: 700,
    });
    const res = await request(makeApp())
      .post("/api/travel/suppliers/100/invoice-uploads/500/match")
      .set("Authorization", `Bearer ${tokenFor("ADMIN")}`)
      .send({ payableId: 700 });
    expect(res.status, `match: ${res.text}`).toBe(200);
    expect(res.body.matchStatus).toBe("matched");
  });

  test("match missing payableId → 400 MISSING_FIELDS", async () => {
    prisma.travelSupplier.findFirst.mockResolvedValue(PARENT_SUPPLIER);
    const res = await request(makeApp())
      .post("/api/travel/suppliers/100/invoice-uploads/500/match")
      .set("Authorization", `Bearer ${tokenFor("ADMIN")}`)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("MISSING_FIELDS");
  });

  test("DELETE MANAGER → 403 (ADMIN-only)", async () => {
    const res = await request(makeApp())
      .delete("/api/travel/suppliers/100/invoice-uploads/500")
      .set("Authorization", `Bearer ${tokenFor("MANAGER")}`);
    expect(res.status).toBe(403);
  });

  test("DELETE happy path → 200 { ok: true }", async () => {
    prisma.travelSupplier.findFirst.mockResolvedValue(PARENT_SUPPLIER);
    prisma.travelSupplierInvoiceUpload.findFirst.mockResolvedValue({
      id: 500,
      tenantId: 1,
      supplierId: 100,
      fileUrl: "/uploads/supplier-invoices/abc.pdf",
      filename: "abc.pdf",
    });
    prisma.travelSupplierInvoiceUpload.delete.mockResolvedValue({});
    const res = await request(makeApp())
      .delete("/api/travel/suppliers/100/invoice-uploads/500")
      .set("Authorization", `Bearer ${tokenFor("ADMIN")}`);
    expect(res.status, `del: ${res.text}`).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  test("DELETE missing upload → 404 UPLOAD_NOT_FOUND", async () => {
    prisma.travelSupplier.findFirst.mockResolvedValue(PARENT_SUPPLIER);
    prisma.travelSupplierInvoiceUpload.findFirst.mockResolvedValue(null);
    const res = await request(makeApp())
      .delete("/api/travel/suppliers/100/invoice-uploads/500")
      .set("Authorization", `Bearer ${tokenFor("ADMIN")}`);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe("UPLOAD_NOT_FOUND");
  });
});

// ─── GET invoice uploads list ─────────────────────────────────────────

describe("GET /invoice-uploads", () => {
  test("happy path returns scoped list", async () => {
    prisma.travelSupplier.findFirst.mockResolvedValue(PARENT_SUPPLIER);
    prisma.travelSupplierInvoiceUpload.findMany.mockResolvedValue([
      {
        id: 500,
        supplierId: 100,
        filename: "invoice.pdf",
        matchStatus: "unmatched",
      },
    ]);
    prisma.travelSupplierInvoiceUpload.count.mockResolvedValue(1);
    const res = await request(makeApp())
      .get("/api/travel/suppliers/100/invoice-uploads")
      .set("Authorization", `Bearer ${tokenFor("ADMIN")}`);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.uploads).toHaveLength(1);
  });
});
