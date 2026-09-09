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
});

describe("travel Tally route guards and envelopes", () => {
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
