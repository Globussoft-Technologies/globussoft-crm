// TMC parent customer-review API coverage. Parent reviews are only available
// for the authenticated parent's completed trips and are stored in the same
// TravelTripReview table used by the travel admin Customer Reviews page.

import { describe, test, expect, beforeEach, vi } from "vitest";
import prisma from "../../lib/prisma.js";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import { createRequire } from "node:module";

const requireCJS = createRequire(import.meta.url);
const JWT_SECRET = process.env.JWT_SECRET || "enterprise_super_secret_key_2026";

prisma.tenant = { ...(prisma.tenant || {}), findUnique: vi.fn() };
prisma.contact = { ...(prisma.contact || {}), findFirst: vi.fn() };
prisma.tmcParentTrip = { ...(prisma.tmcParentTrip || {}), findMany: vi.fn() };
prisma.tripParticipant = { ...(prisma.tripParticipant || {}), findMany: vi.fn() };
prisma.tmcTrip = { ...(prisma.tmcTrip || {}), findMany: vi.fn(), findFirst: vi.fn() };
prisma.travelTripReview = {
  ...(prisma.travelTripReview || {}),
  findMany: vi.fn(),
  findFirst: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
};
prisma.revokedToken = { ...(prisma.revokedToken || {}), findUnique: vi.fn() };
prisma.tenantSetting = { ...(prisma.tenantSetting || {}), findUnique: vi.fn() };

const sentimentEngine = requireCJS("../../cron/sentimentEngine");
sentimentEngine.analyzeMessageDetailed = vi.fn();
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

function parent() {
  return { id: 55, name: "Arijit Singh", email: "arijit@example.com", subBrand: "tmc", portalRole: "PARENT" };
}

function trip(overrides = {}) {
  return {
    id: 7,
    tenantId: 1,
    tripCode: "DARJ-2026",
    destination: "Darjeeling",
    tripType: "international",
    departDate: new Date("2026-08-01T00:00:00.000Z"),
    returnDate: new Date("2026-08-07T00:00:00.000Z"),
    status: "completed",
    ...overrides,
  };
}

beforeEach(() => {
  prisma.tenant.findUnique.mockReset().mockResolvedValue({ id: 1, vertical: "travel", slug: "travel-stall" });
  prisma.contact.findFirst.mockReset().mockResolvedValue(parent());
  prisma.tmcParentTrip.findMany.mockReset().mockResolvedValue([{ tripId: 7 }]);
  prisma.tripParticipant.findMany.mockReset().mockResolvedValue([]);
  prisma.tmcTrip.findMany.mockReset().mockResolvedValue([trip()]);
  prisma.tmcTrip.findFirst.mockReset().mockResolvedValue(trip());
  prisma.travelTripReview.findMany.mockReset().mockResolvedValue([]);
  prisma.travelTripReview.findFirst.mockReset().mockResolvedValue(null);
  prisma.travelTripReview.create.mockReset().mockImplementation(async ({ data }) => ({ id: 91, ...data }));
  prisma.travelTripReview.update.mockReset().mockImplementation(async ({ data }) => ({ id: 91, ...data }));
  prisma.tenantSetting.findUnique.mockReset().mockResolvedValue(null);
  sentimentEngine.analyzeMessageDetailed.mockReset().mockResolvedValue({
    sentiment: "neutral", sentimentScore: 0, provider: "rule-based", trusted: false, usedFallback: true,
  });
  prisma.revokedToken.findUnique.mockReset().mockResolvedValue(null);
});

describe("TMC parent customer reviews", () => {
  test("lists only completed trips belonging to the authenticated parent and includes an existing review", async () => {
    prisma.travelTripReview.findMany.mockResolvedValue([{
      id: 91,
      tmcTripId: 7,
      status: "submitted",
      overallRating: 5,
      answersJson: JSON.stringify({ parent_rating: 5, experience: "Excellent trip." }),
      submittedAt: new Date("2026-08-09T10:00:00.000Z"),
    }]);

    const response = await request(makeApp())
      .get("/api/portal/tmc/parent/reviews")
      .set("Authorization", `Bearer ${portalToken()}`);

    expect(response.status).toBe(200);
    expect(response.body.trips).toEqual([expect.objectContaining({
      id: 7,
      destination: "Darjeeling",
      reviewSubmitted: true,
      review: expect.objectContaining({ overallRating: 5, answers: { parent_rating: 5, experience: "Excellent trip." } }),
    })]);
    expect(prisma.tmcTrip.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { tenantId: 1, id: { in: [7] }, status: "completed" },
    }));
    expect(prisma.travelTripReview.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { tenantId: 1, tmcTripId: { in: [7] }, contactId: 55 },
    }));
  });

  test("returns the short rating-and-experience form for a completed parent trip", async () => {
    const response = await request(makeApp())
      .get("/api/portal/tmc/parent/reviews/7")
      .set("Authorization", `Bearer ${portalToken()}`);

    expect(response.status).toBe(200);
    expect(response.body.trip).toMatchObject({ id: 7, destination: "Darjeeling", status: "completed" });
    expect(response.body.form).toMatchObject({
      formTitle: "How was your trip to Darjeeling?",
      fields: expect.arrayContaining([
        expect.objectContaining({ id: "rating", max: 5 }),
        expect.objectContaining({ id: "experience", required: true }),
      ]),
    });
    expect(response.body.review).toBeNull();
  });

  test("rejects review submission until the parent trip is completed", async () => {
    prisma.tmcTrip.findFirst.mockResolvedValue(trip({ status: "confirmed" }));

    const response = await request(makeApp())
      .post("/api/portal/tmc/parent/trips/7/review")
      .set("Authorization", `Bearer ${portalToken()}`)
      .send({ answers: { rating: 5, experience: "Great trip." } });

    expect(response.status).toBe(409);
    expect(response.body.code).toBe("TRIP_NOT_COMPLETED");
    expect(prisma.travelTripReview.create).not.toHaveBeenCalled();
  });

  test("stores a parent rating and experience, then returns the configured positive-review redirect", async () => {
    prisma.tenantSetting.findUnique.mockResolvedValue({ value: "https://example.com/review" });
    sentimentEngine.analyzeMessageDetailed.mockResolvedValue({
      sentiment: "positive", sentimentScore: 0.9, provider: "gemini", trusted: true, usedFallback: false,
    });

    const response = await request(makeApp())
      .post("/api/portal/tmc/parent/trips/7/review")
      .set("Authorization", `Bearer ${portalToken()}`)
      .send({ answers: { rating: 5, experience: "The trip was excellent and very well organised." } });

    expect(response.status).toBe(201);
    expect(response.body.externalReview).toMatchObject({ enabled: true, url: "https://example.com/review" });
    expect(prisma.travelTripReview.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ tenantId: 1, tmcTripId: 7, contactId: 55, overallRating: 5, status: "submitted" }),
    }));
    const saved = JSON.parse(prisma.travelTripReview.create.mock.calls[0][0].data.answersJson);
    expect(saved).toEqual({ parent_rating: 5, experience: "The trip was excellent and very well organised." });
  });

  test("does not create a second review for the same parent and trip", async () => {
    prisma.travelTripReview.findFirst.mockResolvedValue({ id: 91, status: "submitted" });

    const response = await request(makeApp())
      .post("/api/portal/tmc/parent/trips/7/review")
      .set("Authorization", `Bearer ${portalToken()}`)
      .send({ answers: { rating: 4, experience: "Good trip." } });

    expect(response.status).toBe(409);
    expect(response.body.code).toBe("ALREADY_SUBMITTED");
    expect(prisma.travelTripReview.create).not.toHaveBeenCalled();
  });
});
