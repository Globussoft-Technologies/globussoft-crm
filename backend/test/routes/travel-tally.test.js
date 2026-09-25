import { beforeEach, describe, expect, test, vi } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import { createRequire } from "node:module";
import prisma from "../../lib/prisma.js";

const requireCJS = createRequire(import.meta.url);
const JWT_SECRET = process.env.JWT_SECRET || "enterprise_super_secret_key_2026";

prisma.tenant = prisma.tenant || {};
prisma.tenant.findUnique = vi.fn();
prisma.user = prisma.user || {};
prisma.user.findUnique = vi.fn();
prisma.revokedToken = prisma.revokedToken || {};
prisma.revokedToken.findUnique = vi.fn().mockResolvedValue(null);
prisma.auditLog = {
  ...(prisma.auditLog || {}),
  create: vi.fn().mockResolvedValue({ id: 1 }),
  findFirst: vi.fn().mockResolvedValue(null),
};
prisma.travelTallyLedger = {
  findMany: vi.fn(),
  findFirst: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
};
prisma.travelTallyPaymentAccount = {
  findMany: vi.fn(),
  upsert: vi.fn(),
  updateMany: vi.fn(),
};
prisma.travelTallyTaxMaster = {
  findMany: vi.fn(),
  upsert: vi.fn(),
  updateMany: vi.fn(),
};
prisma.travelTallyMapping = {
  findMany: vi.fn(),
  findFirst: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  deleteMany: vi.fn(),
};
prisma.travelTallySyncQueue = {
  findMany: vi.fn(),
};
prisma.travelTallyCostCentre = {
  findMany: vi.fn(),
  upsert: vi.fn(),
};
prisma.travelTallySyncLog = {
  ...(prisma.travelTallySyncLog || {}),
  findMany: vi.fn(),
};
prisma.itinerary = { ...(prisma.itinerary || {}), findMany: vi.fn(), findFirst: vi.fn() };
prisma.tmcTrip = { ...(prisma.tmcTrip || {}), findMany: vi.fn(), findFirst: vi.fn() };
prisma.travelQuote = { ...(prisma.travelQuote || {}), findMany: vi.fn(), findFirst: vi.fn() };
prisma.$transaction = vi.fn(async (operations) => Promise.all(operations));

const travelTallyRouter = requireCJS("../../routes/travel_tally");

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/travel", travelTallyRouter);
  return app;
}

function tokenFor(role = "ADMIN", tenantId = 1) {
  return jwt.sign(
    { userId: 7, tenantId, role, email: `${role.toLowerCase()}@test.local` },
    JWT_SECRET,
    { expiresIn: "1h" },
  );
}

const auth = () => ({ Authorization: `Bearer ${tokenFor()}` });

beforeEach(() => {
  prisma.tenant.findUnique.mockReset().mockResolvedValue({
    id: 1,
    vertical: "travel",
    name: "Travel Test",
    slug: "travel-test",
  });
  prisma.user.findUnique.mockReset().mockResolvedValue({ role: "ADMIN", subBrandAccess: null });
  prisma.revokedToken.findUnique.mockReset().mockResolvedValue(null);
  prisma.auditLog.create.mockReset().mockResolvedValue({ id: 1 });
  prisma.auditLog.findFirst.mockReset().mockResolvedValue(null);
  for (const delegate of [
    prisma.travelTallyLedger,
    prisma.travelTallyPaymentAccount,
    prisma.travelTallyTaxMaster,
    prisma.travelTallyMapping,
    prisma.travelTallySyncQueue,
    prisma.travelTallyCostCentre,
    prisma.travelTallySyncLog,
  ]) {
    for (const fn of Object.values(delegate)) {
      if (typeof fn === "function" && fn.mockReset) fn.mockReset();
    }
  }
  prisma.travelTallyLedger.findMany.mockResolvedValue([]);
  prisma.travelTallyPaymentAccount.findMany.mockResolvedValue([]);
  prisma.travelTallyTaxMaster.findMany.mockResolvedValue([]);
  prisma.travelTallyMapping.findMany.mockResolvedValue([]);
  prisma.travelTallySyncQueue.findMany.mockResolvedValue([]);
  prisma.travelTallyCostCentre.findMany.mockResolvedValue([]);
  prisma.travelTallySyncLog.findMany.mockResolvedValue([]);
  prisma.travelTallyCostCentre.upsert.mockImplementation(async ({ create }) => ({ id: create.sourceId, ...create }));
  prisma.itinerary.findMany.mockReset().mockResolvedValue([]);
  prisma.itinerary.findFirst.mockReset();
  prisma.tmcTrip.findMany.mockReset().mockResolvedValue([]);
  prisma.tmcTrip.findFirst.mockReset();
  prisma.travelQuote.findMany.mockReset().mockResolvedValue([]);
  prisma.travelQuote.findFirst.mockReset();
});

describe("travel Tally cost centre sources", () => {
  test("lists itineraries, TMC trips, and quote-only trips", async () => {
    prisma.itinerary.findMany.mockResolvedValue([{ id: 3, destination: "Agra", subBrand: "rfu" }]);
    prisma.tmcTrip.findMany.mockResolvedValue([{ id: 8, tripCode: "SCHOOL-8", destination: "Singapore" }]);
    prisma.travelQuote.findMany.mockResolvedValue([{ id: 12, subBrand: "visasure", contact: { name: "Customer One" } }]);

    const response = await request(makeApp()).get("/api/travel/tally/cost-centres").set(auth());

    expect(response.status).toBe(200);
    expect(response.body.sources).toEqual(expect.arrayContaining([
      expect.objectContaining({ sourceType: "ITINERARY", code: "TRIP-3" }),
      expect.objectContaining({ sourceType: "TMC_TRIP", code: "TMC-TRIP-8" }),
      expect.objectContaining({ sourceType: "QUOTE", code: "QUOTE-12" }),
    ]));
    expect(response.body.pagination).toEqual({ page: 1, limit: 50, hasMore: false });
    expect(response.body.sourcePagination).toEqual({ page: 1, limit: 100, hasMore: false });
    expect(prisma.itinerary.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { tenantId: 1 },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      skip: 0,
      take: 101,
    }));
  });

  test("caps page sizes and reports another source page without truncating it permanently", async () => {
    prisma.itinerary.findMany.mockResolvedValue(Array.from({ length: 101 }, (_, index) => ({ id: 200 - index, destination: `Trip ${index}` })));

    const response = await request(makeApp()).get("/api/travel/tally/cost-centres?page=2&limit=999&sourcePage=2&sourceLimit=999").set(auth());

    expect(response.status).toBe(200);
    expect(response.body.sources).toHaveLength(100);
    expect(response.body.sourcePagination).toEqual({ page: 2, limit: 100, hasMore: true });
    expect(prisma.travelTallyCostCentre.findMany).toHaveBeenCalledWith(expect.objectContaining({ skip: 100, take: 101 }));
    expect(prisma.itinerary.findMany).toHaveBeenCalledWith(expect.objectContaining({ skip: 100, take: 101 }));
  });

  test("returns the last successful voucher sync time for each cost centre", async () => {
    const syncedAt = new Date("2026-09-15T10:00:00.000Z");
    const failedAt = new Date("2026-09-16T10:00:00.000Z");
    prisma.travelTallyCostCentre.findMany.mockResolvedValue([
      { id: 1, tenantId: 1, sourceType: "ITINERARY", sourceId: 3, code: "TRIP-3", syncStatus: "SYNCED" },
    ]);
    prisma.travelTallySyncLog.findMany.mockResolvedValue([
      { createdAt: failedAt, status: "FAILED", requestPayload: "<VOUCHER><COSTCENTREALLOCATIONS.LIST><NAME>TRIP-3</NAME></COSTCENTREALLOCATIONS.LIST></VOUCHER>" },
      { createdAt: syncedAt, status: "SYNCED", requestPayload: "<VOUCHER><COSTCENTREALLOCATIONS.LIST><NAME>TRIP-3</NAME></COSTCENTREALLOCATIONS.LIST></VOUCHER>" },
    ]);

    const response = await request(makeApp()).get("/api/travel/tally/cost-centres").set(auth());

    expect(response.status).toBe(200);
    expect(response.body.costCentres[0].voucherSyncStatus).toBe("FAILED");
    expect(response.body.costCentres[0].lastVoucherSyncAt).toBe(syncedAt.toISOString());
    expect(prisma.travelTallySyncLog.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { tenantId: 1, sourceType: "DIRECT_EXPORT", voucherType: "VOUCHERS", status: { in: ["SYNCED", "FAILED"] } },
    }));
  });

  test("prepares missing cost centres in a bounded deterministic batch", async () => {
    prisma.tmcTrip.findMany.mockResolvedValue([{ id: 8, tripCode: "SCHOOL-8", destination: "Singapore" }]);

    const response = await request(makeApp()).post("/api/travel/tally/cost-centres/prepare-missing").set(auth()).send({ sourceType: "TMC_TRIP", afterSourceId: 3, limit: 500 });

    expect(response.status).toBe(201);
    expect(response.body).toEqual(expect.objectContaining({ sourceType: "TMC_TRIP", created: 1, processed: 1, nextAfterSourceId: 8, done: true }));
    expect(prisma.tmcTrip.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { tenantId: 1, id: { gt: 3 } },
      orderBy: { id: "asc" },
      take: 100,
    }));
    expect(prisma.travelTallyCostCentre.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { tenantId: 1, sourceType: "TMC_TRIP", sourceId: { in: [8] } },
    }));
    expect(prisma.travelTallyCostCentre.upsert).toHaveBeenCalledTimes(1);
    expect(prisma.travelTallyCostCentre.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({ sourceType: "TMC_TRIP", sourceId: 8, code: "TMC-TRIP-8" }),
    }));
  });

  test("rejects an invalid bulk source before reading tenant data", async () => {
    const response = await request(makeApp()).post("/api/travel/tally/cost-centres/prepare-missing").set(auth()).send({ sourceType: "OTHER" });

    expect(response.status).toBe(400);
    expect(response.body.code).toBe("INVALID_COST_CENTRE_SOURCE");
    expect(prisma.itinerary.findMany).not.toHaveBeenCalled();
    expect(prisma.tmcTrip.findMany).not.toHaveBeenCalled();
    expect(prisma.travelQuote.findMany).not.toHaveBeenCalled();
  });

  test("returns 404 for a source outside the authenticated tenant", async () => {
    prisma.tmcTrip.findFirst.mockResolvedValue(null);

    const response = await request(makeApp()).post("/api/travel/tally/cost-centres").set(auth()).send({ sourceType: "TMC_TRIP", sourceId: 999 });

    expect(response.status).toBe(404);
    expect(response.body.code).toBe("COST_CENTRE_SOURCE_NOT_FOUND");
    expect(prisma.tmcTrip.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 999, tenantId: 1 },
    }));
    expect(prisma.travelTallyCostCentre.upsert).not.toHaveBeenCalled();
  });
});

describe("travel Tally route guards and envelopes", () => {
  test.each([
    "/api/travel/tally/master-bank-details",
    "/api/travel/tally/master-details",
  ])("rejects an invalid bank account number on %s", async (path) => {
    const response = await request(makeApp())
      .put(path)
      .set(auth())
      .send({ bankDetails: { accountNumber: "not-a-bank-account" } });

    expect(response.status).toBe(400);
    expect(response.body.code).toBe("INVALID_BANK_ACCOUNT_NUMBER");
  });

  test("requires authentication", async () => {
    const response = await request(makeApp()).get("/api/travel/tally/masters");
    expect([401, 403]).toContain(response.status);
  });

  test("rejects a non-travel tenant", async () => {
    prisma.tenant.findUnique.mockResolvedValue({ id: 1, vertical: "generic", name: "Generic", slug: "generic" });
    const response = await request(makeApp()).get("/api/travel/tally/masters").set(auth());
    expect(response.status).toBe(403);
    expect(response.body.code).toBe("WRONG_VERTICAL");
  });

  test("returns tenant-scoped masters in a stable envelope", async () => {
    prisma.travelTallyLedger.findMany.mockResolvedValue([{ id: 10, tenantId: 1, ledgerName: "Bank" }]);
    const response = await request(makeApp()).get("/api/travel/tally/masters?subBrand=tmc").set(auth());
    expect(response.status).toBe(200);
    expect(response.body.ledgers).toHaveLength(1);
    expect(prisma.travelTallyLedger.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { tenantId: 1, subBrand: "tmc" },
      orderBy: [{ ledgerCategory: "asc" }, { ledgerName: "asc" }],
    }));
  });

  test("returns a tenant-scoped, capped sync queue", async () => {
    const response = await request(makeApp()).get("/api/travel/tally/sync-queue").set(auth());
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ queue: [] });
    expect(prisma.travelTallySyncQueue.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { tenantId: 1 },
      orderBy: { createdAt: "desc" },
      take: 500,
    }));
  });
});

describe("travel Tally ledger references", () => {
  test.each([
    ["payment-accounts", { mode: "bank", accountName: "Primary", ledgerId: "not-an-id" }],
    ["tax-masters", { taxName: "GST", taxType: "GST", rate: 18, ledgerId: -2 }],
  ])("rejects invalid ledger ids for %s", async (path, body) => {
    const response = await request(makeApp()).post(`/api/travel/tally/${path}`).set(auth()).send(body);
    expect(response.status).toBe(400);
    expect(response.body.code).toBe("INVALID_LEDGER_ID");
  });

  test.each([
    ["payment-accounts", { mode: "bank", accountName: "Primary", ledgerId: 999 }],
    ["tax-masters", { taxName: "GST", taxType: "GST", rate: 18, ledgerId: 999 }],
  ])("rejects a ledger outside the current tenant for %s", async (path, body) => {
    prisma.travelTallyLedger.findFirst.mockResolvedValue(null);
    const response = await request(makeApp()).post(`/api/travel/tally/${path}`).set(auth()).send(body);
    expect(response.status).toBe(404);
    expect(response.body.code).toBe("LEDGER_NOT_FOUND");
    expect(prisma.travelTallyLedger.findFirst).toHaveBeenCalledWith({
      where: { id: 999, tenantId: 1 },
      select: { id: true },
    });
    expect(prisma.travelTallyPaymentAccount.upsert).not.toHaveBeenCalled();
    expect(prisma.travelTallyTaxMaster.upsert).not.toHaveBeenCalled();
  });

  test("creates a payment account only after validating an owned ledger", async () => {
    prisma.travelTallyLedger.findFirst.mockResolvedValue({ id: 20 });
    prisma.travelTallyPaymentAccount.upsert.mockResolvedValue({ id: 30, tenantId: 1, ledgerId: 20, mode: "bank", accountName: "Primary" });
    const response = await request(makeApp())
      .post("/api/travel/tally/payment-accounts")
      .set(auth())
      .send({ mode: "bank", accountName: "Primary", ledgerId: 20 });
    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({ id: 30, tenantId: 1, ledgerId: 20 });
    expect(prisma.travelTallyPaymentAccount.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({ tenantId: 1, ledgerId: 20 }),
    }));
  });
});
