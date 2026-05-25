// @ts-check
import { describe, it, expect, vi, beforeEach } from "vitest";
import { findLatestDiagnostic } from "../../lib/travelLatestDiagnostic.js";

describe("travelLatestDiagnostic.findLatestDiagnostic", () => {
  let prisma;

  beforeEach(() => {
    prisma = { travelDiagnostic: { findFirst: vi.fn() } };
  });

  it("returns null and does NOT query when any required arg is missing", async () => {
    expect(await findLatestDiagnostic(null, 1, 1, "rfu")).toBeNull();
    expect(await findLatestDiagnostic(prisma, NaN, 1, "rfu")).toBeNull();
    expect(await findLatestDiagnostic(prisma, 1, NaN, "rfu")).toBeNull();
    expect(await findLatestDiagnostic(prisma, 1, 1, "")).toBeNull();
    expect(await findLatestDiagnostic(prisma, 1, 1, null)).toBeNull();
    expect(await findLatestDiagnostic(prisma, 1, 1, 42)).toBeNull();
    expect(prisma.travelDiagnostic.findFirst).not.toHaveBeenCalled();
  });

  it("queries with the correct where, orderBy, and narrow select", async () => {
    prisma.travelDiagnostic.findFirst.mockResolvedValue({
      id: 42,
      score: 7.5,
      classification: "level_2",
      classificationLabel: "Confident & Prepared",
      recommendedTier: "premium",
      createdAt: new Date("2026-05-20T10:00:00Z"),
    });
    const row = await findLatestDiagnostic(prisma, 7, 100, "rfu");
    expect(prisma.travelDiagnostic.findFirst).toHaveBeenCalledWith({
      where: { tenantId: 7, contactId: 100, subBrand: "rfu" },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        score: true,
        classification: true,
        classificationLabel: true,
        recommendedTier: true,
        createdAt: true,
      },
    });
    expect(row).toMatchObject({
      id: 42,
      recommendedTier: "premium",
      classification: "level_2",
    });
  });

  it("returns null when no diagnostic row exists for the contact/subBrand", async () => {
    prisma.travelDiagnostic.findFirst.mockResolvedValue(null);
    expect(await findLatestDiagnostic(prisma, 1, 2, "tmc")).toBeNull();
  });

  it("does not leak Text columns (questionsJson / answersJson / talkingPointsJson)", async () => {
    prisma.travelDiagnostic.findFirst.mockResolvedValue({ id: 1 });
    await findLatestDiagnostic(prisma, 1, 1, "travelstall");
    const call = prisma.travelDiagnostic.findFirst.mock.calls[0][0];
    expect(call.select).not.toHaveProperty("questionsJson");
    expect(call.select).not.toHaveProperty("answersJson");
    expect(call.select).not.toHaveProperty("talkingPointsJson");
  });
});
