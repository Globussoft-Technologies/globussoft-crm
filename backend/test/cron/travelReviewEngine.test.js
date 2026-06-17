// Unit tests for cron/travelReviewEngine.js — scan completed (paid,
// non-visasure) itineraries → skip already-reviewed → create review row +
// token → email. Singletons grabbed via createRequire + monkeypatched.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequire } from "node:module";

const requireCJS = createRequire(import.meta.url);
const prisma = requireCJS("../../lib/prisma");
const emailSender = requireCJS("../../lib/emailSender");
const content = requireCJS("../../lib/travelReviewContent");
const { runTravelReviewTick } = requireCJS("../../cron/travelReviewEngine");

const NOW = new Date("2026-06-20T09:00:00Z");
const daysAgo = (d) => new Date(NOW.getTime() - d * 86400000);

beforeEach(() => {
  prisma.itinerary = { findMany: vi.fn() };
  prisma.travelTripReview = { findMany: vi.fn(), create: vi.fn() };
  prisma.contact = { findMany: vi.fn() };
  emailSender.sendEmail = vi.fn();
  content.buildRequestEmail = vi.fn(() => ({ subject: "How was your trip?", text: "T", html: "T" }));

  prisma.travelTripReview.findMany.mockResolvedValue([]); // none reviewed yet
  prisma.contact.findMany.mockResolvedValue([{ id: 7, name: "Mohit", email: "mohit@example.com" }]);
  prisma.travelTripReview.create.mockResolvedValue({ id: 100 });
  emailSender.sendEmail.mockResolvedValue({ sent: true });
});

function itin(overrides = {}) {
  return { id: 1, tenantId: 1, contactId: 7, destination: "Bali", endDate: daysAgo(1), ...overrides };
}

describe("travelReviewEngine — scope query", () => {
  it("scans committed, non-visasure itineraries completed within the lookback", async () => {
    prisma.itinerary.findMany.mockResolvedValue([]);
    await runTravelReviewTick(NOW);
    const where = prisma.itinerary.findMany.mock.calls[0][0].where;
    expect(where.status).toEqual({ in: ["accepted", "advance_paid", "fully_paid"] });
    expect(where.subBrand).toEqual({ not: "visasure" });
    expect(where.endDate).toHaveProperty("gte");
    expect(where.endDate).toHaveProperty("lt");
  });
});

describe("travelReviewEngine — fire", () => {
  it("creates a review row (with a token) and emails the customer", async () => {
    prisma.itinerary.findMany.mockResolvedValue([itin()]);
    const s = await runTravelReviewTick(NOW);
    const createArg = prisma.travelTripReview.create.mock.calls[0][0];
    expect(createArg.data).toMatchObject({ itineraryId: 1, contactId: 7, status: "requested" });
    expect(typeof createArg.data.token).toBe("string");
    expect(createArg.data.token.length).toBeGreaterThan(10);
    expect(content.buildRequestEmail).toHaveBeenCalledWith(expect.objectContaining({ destination: "Bali" }));
    expect(emailSender.sendEmail).toHaveBeenCalledWith(expect.objectContaining({ to: "mohit@example.com" }));
    expect(s).toMatchObject({ requested: 1, sent: 1 });
  });
});

describe("travelReviewEngine — guards", () => {
  it("skips an itinerary that already has a review row", async () => {
    prisma.itinerary.findMany.mockResolvedValue([itin()]);
    prisma.travelTripReview.findMany.mockResolvedValue([{ itineraryId: 1 }]);
    const s = await runTravelReviewTick(NOW);
    expect(prisma.travelTripReview.create).not.toHaveBeenCalled();
    expect(emailSender.sendEmail).not.toHaveBeenCalled();
    expect(s).toMatchObject({ requested: 0, skipped: 1 });
  });

  it("is idempotent — a unique-violation on create skips without emailing", async () => {
    prisma.itinerary.findMany.mockResolvedValue([itin()]);
    prisma.travelTripReview.create.mockRejectedValue(Object.assign(new Error("dup"), { code: "P2002" }));
    const s = await runTravelReviewTick(NOW);
    expect(emailSender.sendEmail).not.toHaveBeenCalled();
    expect(s).toMatchObject({ skipped: 1 });
  });

  it("skips when the contact has no email", async () => {
    prisma.itinerary.findMany.mockResolvedValue([itin()]);
    prisma.contact.findMany.mockResolvedValue([{ id: 7, name: "Mohit", email: null }]);
    const s = await runTravelReviewTick(NOW);
    expect(prisma.travelTripReview.create).not.toHaveBeenCalled();
    expect(s).toMatchObject({ requested: 0, skipped: 1 });
  });
});
