import { beforeEach, describe, expect, test, vi } from "vitest";
import express from "express";
import request from "supertest";
import prisma from "../../lib/prisma.js";
import { createRequire } from "node:module";

prisma.plotSite = { findMany: vi.fn() };
prisma.user = { findMany: vi.fn() };
prisma.plotCommissionPlan = { findMany: vi.fn() };
prisma.plotBooking = { findMany: vi.fn() };
prisma.contact = { findMany: vi.fn() };
prisma.paymentReceipt = { findMany: vi.fn() };

const requireCJS = createRequire(import.meta.url);
const plotCommissionRouter = requireCJS("../../routes/plot_commissions");

function makeApp() {
  const app = express();
  app.use((req, _res, next) => {
    req.user = { userId: 7, tenantId: 1, role: "ADMIN" };
    next();
  });
  app.use("/api/commissions", plotCommissionRouter);
  return app;
}

beforeEach(() => {
  prisma.plotSite.findMany.mockReset();
  prisma.user.findMany.mockReset();
  prisma.plotCommissionPlan.findMany.mockReset();
  prisma.plotBooking.findMany.mockReset();
  prisma.contact.findMany.mockReset();
  prisma.paymentReceipt.findMany.mockReset();

  prisma.plotSite.findMany.mockResolvedValue([
    { id: 30, name: "Electronic City Greens", plotNumber: "F-601", block: null, price: 7500000, availability: "AVAILABLE" },
  ]);
  prisma.plotCommissionPlan.findMany.mockResolvedValue([]);
  prisma.plotBooking.findMany.mockResolvedValue([]);
});

describe("GET /api/commissions/workspace staff roles", () => {
  test("returns primary RBAC role names and excludes legacy and RBAC admins", async () => {
    prisma.user.findMany.mockResolvedValue([
      {
        id: 21,
        name: "Priya Patel",
        email: "priya@example.com",
        role: "USER",
        jobTitle: null,
        userRoles: [{ role: { id: 12, key: "BROKER", name: "Broker" } }],
      },
      {
        id: 22,
        name: "Rajesh Sharma",
        email: "rajesh@example.com",
        role: "USER",
        jobTitle: null,
        userRoles: [{ role: { id: 1, key: "ADMIN", name: "Admin" } }],
      },
      {
        id: 23,
        name: "Sanjay Admin",
        email: "sanjay@example.com",
        role: "ADMIN",
        jobTitle: null,
        userRoles: [],
      },
    ]);

    const response = await request(makeApp()).get("/api/commissions/workspace");

    expect(response.status).toBe(200);
    expect(response.body.staff).toEqual([
      expect.objectContaining({
        id: 21,
        name: "Priya Patel",
        role: "USER",
        primaryRole: { id: 12, key: "BROKER", name: "Broker" },
      }),
    ]);
    expect(response.body.staff).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 22 }),
      expect.objectContaining({ id: 23 }),
    ]));
    expect(prisma.user.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ tenantId: 1, deactivatedAt: null }),
      select: expect.objectContaining({ userRoles: expect.any(Object) }),
    }));
  });
});
