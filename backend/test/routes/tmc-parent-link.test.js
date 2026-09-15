/**
 * Admin-owned TMC parent registration link contract.
 *
 * Parent links use the existing deterministic registration-token helper. The
 * route only moves link generation to the admin trip surface; it does not
 * change the parent registration form or the landing-page handoff.
 */
import { describe, test, expect, beforeEach, vi } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import { createRequire } from "node:module";
import prisma from "../../lib/prisma.js";
import { buildTmcParentRegistrationUrl } from "../../lib/tmcRegistrationContext.js";

const requireCJS = createRequire(import.meta.url);
const JWT_SECRET = process.env.JWT_SECRET || "enterprise_super_secret_key_2026";

prisma.tenant = { ...(prisma.tenant || {}), findUnique: vi.fn() };
prisma.tmcTrip = { ...(prisma.tmcTrip || {}), findFirst: vi.fn() };

const tmcPortalRouter = requireCJS("../../routes/tmc_portal");

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/portal/tmc", tmcPortalRouter);
  return app;
}

function staffToken(role = "ADMIN") {
  return jwt.sign({ userId: 7, tenantId: 1, role }, JWT_SECRET, { expiresIn: "1h" });
}

beforeEach(() => {
  prisma.tenant.findUnique.mockReset().mockResolvedValue({ id: 1, vertical: "travel", slug: "travel-stall" });
  prisma.tmcTrip.findFirst.mockReset().mockResolvedValue({
    id: 12,
    tripCode: "MYSORE-2026",
    destination: "Mysore",
    teacherContactId: 44,
  });
});

describe("POST /api/portal/tmc/staff/trips/:tripId/parent-link", () => {
  test("ADMIN receives the canonical trip-specific parent link", async () => {
    const response = await request(makeApp())
      .post("/api/portal/tmc/staff/trips/12/parent-link")
      .set("Authorization", `Bearer ${staffToken()}`)
      .set("Host", "crm.example.test");

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      linkType: "trip-specific",
      trip: { id: 12, tripCode: "MYSORE-2026", destination: "Mysore" },
    });
    expect(response.body.link).toBe(buildTmcParentRegistrationUrl({
      tenantId: 1,
      teacherContactId: 44,
      tripId: 12,
      baseUrl: process.env.FRONTEND_URL || "http://crm.example.test",
    }));
    expect(prisma.tmcTrip.findFirst).toHaveBeenCalledWith({
      where: { id: 12, tenantId: 1 },
      select: { id: true, tripCode: true, destination: true, teacherContactId: true },
    });
  });

  test("MANAGER cannot generate a parent link", async () => {
    const response = await request(makeApp())
      .post("/api/portal/tmc/staff/trips/12/parent-link")
      .set("Authorization", `Bearer ${staffToken("MANAGER")}`);

    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({ code: "RBAC_DENIED" });
    expect(prisma.tmcTrip.findFirst).not.toHaveBeenCalled();
  });

  test("requires an assigned teacher", async () => {
    prisma.tmcTrip.findFirst.mockResolvedValue({
      id: 12,
      tripCode: "MYSORE-2026",
      destination: "Mysore",
      teacherContactId: null,
    });

    const response = await request(makeApp())
      .post("/api/portal/tmc/staff/trips/12/parent-link")
      .set("Authorization", `Bearer ${staffToken()}`);

    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({ code: "TEACHER_REQUIRED" });
  });

  test("does not expose the old teacher link-generation endpoint", async () => {
    const response = await request(makeApp())
      .post("/api/portal/tmc/teacher/trips/12/parent-link")
      .set("Authorization", `Bearer ${jwt.sign({ type: "PORTAL", tenantId: 1, contactId: 44 }, JWT_SECRET, { expiresIn: "1h" })}`);

    expect(response.status).toBe(404);
  });
});
