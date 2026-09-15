// Travel admin review-list coverage for TMC parent submissions. This keeps
// the shared Customer Reviews API contract explicit: a parent review stored
// against TmcTrip is enriched and visible beside itinerary reviews.

import { describe, test, expect, beforeEach, vi } from "vitest";
import prisma from "../../lib/prisma.js";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import { createRequire } from "node:module";

const requireCJS = createRequire(import.meta.url);
const JWT_SECRET = process.env.JWT_SECRET || "enterprise_super_secret_key_2026";

prisma.tenant = { ...(prisma.tenant || {}), findUnique: vi.fn() };
prisma.user = { ...(prisma.user || {}), findUnique: vi.fn() };
prisma.revokedToken = { ...(prisma.revokedToken || {}), findUnique: vi.fn() };
prisma.travelTripReview = { ...(prisma.travelTripReview || {}), findMany: vi.fn() };
prisma.tmcTripTeacherReview = { ...(prisma.tmcTripTeacherReview || {}), findMany: vi.fn() };
prisma.itinerary = { ...(prisma.itinerary || {}), findMany: vi.fn() };
prisma.tmcTrip = { ...(prisma.tmcTrip || {}), findMany: vi.fn() };
prisma.contact = { ...(prisma.contact || {}), findMany: vi.fn() };

const travelReviewsRouter = requireCJS("../../routes/travel_reviews");

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/travel", travelReviewsRouter);
  return app;
}

function token(role = "ADMIN") {
  return jwt.sign({ userId: 7, tenantId: 1, role, email: "admin@example.com" }, JWT_SECRET, { expiresIn: "1h" });
}

beforeEach(() => {
  prisma.tenant.findUnique.mockReset().mockResolvedValue({ id: 1, vertical: "travel", name: "Travel", slug: "travel-stall" });
  prisma.user.findUnique.mockReset().mockResolvedValue({ id: 7, role: "ADMIN", subBrandAccess: null });
  prisma.revokedToken.findUnique.mockReset().mockResolvedValue(null);
  prisma.travelTripReview.findMany.mockReset().mockResolvedValue([]);
  prisma.tmcTripTeacherReview.findMany.mockReset().mockResolvedValue([]);
  prisma.itinerary.findMany.mockReset().mockResolvedValue([]);
  prisma.tmcTrip.findMany.mockReset().mockResolvedValue([]);
  prisma.contact.findMany.mockReset().mockResolvedValue([]);
});

describe("GET /api/travel/reviews", () => {
  test("enriches a TMC parent review for the admin Customer Reviews list", async () => {
    prisma.travelTripReview.findMany.mockResolvedValue([{
      id: 91,
      itineraryId: null,
      tmcTripId: 7,
      contactId: 55,
      overallRating: 5,
      answersJson: JSON.stringify({ parent_rating: 5, experience: "The trip was excellent." }),
      submittedAt: new Date("2026-08-09T10:00:00.000Z"),
    }]);
    prisma.tmcTrip.findMany.mockResolvedValue([{
      id: 7,
      tripCode: "DARJ-2026",
      destination: "Darjeeling",
      tripType: "international",
      departDate: new Date("2026-08-01T00:00:00.000Z"),
      returnDate: new Date("2026-08-07T00:00:00.000Z"),
      status: "completed",
    }]);
    prisma.contact.findMany.mockResolvedValue([{ id: 55, name: "Arijit Singh", email: "arijit@example.com", phone: "+91 99999 99999" }]);

    const response = await request(makeApp())
      .get("/api/travel/reviews")
      .set("Authorization", `Bearer ${token()}`);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ total: 1, reviews: [{
      id: 91,
      destination: "Darjeeling",
      subBrand: "tmc",
      tripCode: "DARJ-2026",
      contactName: "Arijit Singh",
      answers: { parent_rating: 5, experience: "The trip was excellent." },
    }] });
    expect(prisma.itinerary.findMany).not.toHaveBeenCalled();
    expect(prisma.tmcTrip.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { tenantId: 1, id: { in: [7] } },
    }));
  });
});

describe("GET /api/travel/teacher-reviews", () => {
  test("allows staff with TMC sub-brand access", async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 7,
      role: "USER",
      subBrandAccess: JSON.stringify(["tmc"]),
    });

    const response = await request(makeApp())
      .get("/api/travel/teacher-reviews")
      .set("Authorization", `Bearer ${token("USER")}`);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ reports: [], total: 0 });
    expect(prisma.tmcTripTeacherReview.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { tenantId: 1 } }),
    );
  });

  test("rejects staff restricted to another travel sub-brand", async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 7,
      role: "USER",
      subBrandAccess: JSON.stringify(["rfu"]),
    });

    const response = await request(makeApp())
      .get("/api/travel/teacher-reviews")
      .set("Authorization", `Bearer ${token("USER")}`);

    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({ code: "SUB_BRAND_DENIED" });
    expect(prisma.tmcTripTeacherReview.findMany).not.toHaveBeenCalled();
  });
});
