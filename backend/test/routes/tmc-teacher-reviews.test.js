// @ts-check
/**
 * TMC teacher tour-report API coverage.
 *
 * Teachers can only see reports for their own tenant/assignment and only
 * after the trip lifecycle reaches `completed`. The same report can be
 * updated, which keeps one report per teacher/trip.
 */

import { describe, test, expect, beforeEach, vi } from "vitest";
import prisma from "../../lib/prisma.js";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import { createRequire } from "node:module";

const requireCJS = createRequire(import.meta.url);
const JWT_SECRET = process.env.JWT_SECRET || "enterprise_super_secret_key_2026";

prisma.tenant = { ...(prisma.tenant || {}), findUnique: vi.fn() };
prisma.contact = { ...(prisma.contact || {}), findFirst: vi.fn(), findMany: vi.fn() };
prisma.tmcTrip = { ...(prisma.tmcTrip || {}), findMany: vi.fn(), findFirst: vi.fn() };
prisma.tmcTripTeacherReview = {
  findMany: vi.fn(),
  findFirst: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
};
prisma.revokedToken = { ...(prisma.revokedToken || {}), findUnique: vi.fn() };

const tmcPortalRouter = requireCJS("../../routes/tmc_portal");

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/portal/tmc", tmcPortalRouter);
  return app;
}

function portalToken() {
  return jwt.sign({ type: "PORTAL", tenantId: 1, contactId: 55 }, JWT_SECRET, { expiresIn: "1h" });
}

function completedTrip(overrides = {}) {
  return {
    id: 7,
    tenantId: 1,
    tripCode: "TMC-007",
    destination: "Mysore",
    tripType: "day_trip",
    departDate: new Date("2026-09-01T00:00:00.000Z"),
    returnDate: new Date("2026-09-01T00:00:00.000Z"),
    status: "completed",
    teacherContactId: 55,
    _count: { participants: 2, pendingRegistrations: 0 },
    ...overrides,
  };
}

function validReport(overrides = {}) {
  return {
    reportDate: "2026-09-01",
    institution: "Greenfield School",
    tourDestination: "Mysore",
    coordinator: "Asha Teacher",
    grade: "7",
    travelRating: "excellent",
    foodRating: "good",
    activitiesRating: "good",
    careSupportRating: "excellent",
    overallRating: "good",
    feedback: "Well organised.",
    studentCount: 30,
    staffCount: 3,
    totalPassengers: 33,
    signature: "Asha Teacher",
    ...overrides,
  };
}

beforeEach(() => {
  prisma.tenant.findUnique.mockReset().mockResolvedValue({ id: 1, vertical: "travel", slug: "tmc" });
  prisma.contact.findFirst.mockReset().mockResolvedValue({ id: 55, name: "Asha Teacher", email: "asha@example.com", subBrand: "tmc", portalRole: "TEACHER" });
  prisma.contact.findMany.mockReset().mockResolvedValue([]);
  prisma.tmcTrip.findMany.mockReset().mockResolvedValue([]);
  prisma.tmcTrip.findFirst.mockReset().mockResolvedValue(completedTrip());
  prisma.tmcTripTeacherReview.findMany.mockReset().mockResolvedValue([]);
  prisma.tmcTripTeacherReview.findFirst.mockReset().mockResolvedValue(null);
  prisma.tmcTripTeacherReview.create.mockReset().mockImplementation(async ({ data }) => ({ id: 44, ...data }));
  prisma.tmcTripTeacherReview.update.mockReset().mockImplementation(async ({ data }) => ({ id: 44, ...data }));
  prisma.revokedToken.findUnique.mockReset().mockResolvedValue(null);
});

describe("TMC teacher tour reports", () => {
  test("lists only completed trips assigned to the authenticated teacher", async () => {
    prisma.tmcTrip.findMany.mockResolvedValue([completedTrip()]);

    const response = await request(makeApp())
      .get("/api/portal/tmc/teacher/reviews")
      .set("Authorization", `Bearer ${portalToken()}`);

    expect(response.status).toBe(200);
    expect(response.body.trips).toHaveLength(1);
    expect(response.body.trips[0]).toMatchObject({ id: 7, destination: "Mysore", review: null, reviewSubmitted: false });
    expect(prisma.tmcTrip.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { tenantId: 1, teacherContactId: 55, status: "completed" },
    }));
  });

  test("creates a report and sanitizes free-text fields", async () => {
    const response = await request(makeApp())
      .put("/api/portal/tmc/teacher/trips/7/review")
      .set("Authorization", `Bearer ${portalToken()}`)
      .send(validReport({ institution: "<b>Greenfield School</b>" }));

    expect(response.status).toBe(201);
    expect(response.body.ok).toBe(true);
    expect(prisma.tmcTripTeacherReview.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        tenantId: 1,
        tripId: 7,
        teacherContactId: 55,
        institution: "Greenfield School",
        overallRating: "good",
      }),
    }));
  });

  test("rejects a report before the trip is completed", async () => {
    prisma.tmcTrip.findFirst.mockResolvedValue(completedTrip({ status: "confirmed" }));

    const response = await request(makeApp())
      .put("/api/portal/tmc/teacher/trips/7/review")
      .set("Authorization", `Bearer ${portalToken()}`)
      .send(validReport());

    expect(response.status).toBe(409);
    expect(response.body.code).toBe("TRIP_NOT_COMPLETED");
    expect(prisma.tmcTripTeacherReview.create).not.toHaveBeenCalled();
  });
});
