// @ts-check

import { describe, test, expect, beforeEach, vi } from "vitest";
import prisma from "../../lib/prisma.js";
import { createRequire } from "node:module";

const requireCJS = createRequire(import.meta.url);
const settings = requireCJS("../../lib/diagnosticRecommendationSettings");

prisma.tenantSetting = {
  ...(prisma.tenantSetting || {}),
  findUnique: vi.fn(),
  upsert: vi.fn(),
};

beforeEach(() => {
  prisma.tenantSetting.findUnique.mockReset();
  prisma.tenantSetting.upsert.mockReset();
});

describe("diagnosticRecommendationSettings — getRecommendationTopK", () => {
  test("returns DEFAULT_TOP_K when no row exists", async () => {
    prisma.tenantSetting.findUnique.mockResolvedValue(null);
    const topK = await settings.getRecommendationTopK({ tenantId: 1, subBrand: "tmc" });
    expect(topK).toBe(settings.DEFAULT_TOP_K);
  });

  test("returns the stored value when present and in range", async () => {
    prisma.tenantSetting.findUnique.mockResolvedValue({ value: JSON.stringify({ topK: 15 }) });
    const topK = await settings.getRecommendationTopK({ tenantId: 1, subBrand: "tmc" });
    expect(topK).toBe(15);
  });

  test("queries by the tenantId + subBrand-scoped key", async () => {
    prisma.tenantSetting.findUnique.mockResolvedValue(null);
    await settings.getRecommendationTopK({ tenantId: 7, subBrand: "tmc" });
    expect(prisma.tenantSetting.findUnique).toHaveBeenCalledWith({
      where: { tenantId_key: { tenantId: 7, key: "travel.diagnostics.topK.tmc" } },
    });
  });

  test("falls back to DEFAULT_TOP_K on a corrupted (non-JSON) row", async () => {
    prisma.tenantSetting.findUnique.mockResolvedValue({ value: "not json" });
    const topK = await settings.getRecommendationTopK({ tenantId: 1, subBrand: "tmc" });
    expect(topK).toBe(settings.DEFAULT_TOP_K);
  });

  test("falls back to DEFAULT_TOP_K when the stored value is out of range", async () => {
    prisma.tenantSetting.findUnique.mockResolvedValue({ value: JSON.stringify({ topK: 9999 }) });
    // Out-of-range values are clamped, not rejected — 9999 clamps to MAX_TOP_K.
    const topK = await settings.getRecommendationTopK({ tenantId: 1, subBrand: "tmc" });
    expect(topK).toBe(settings.MAX_TOP_K);
  });

  test("never throws — a Prisma error also falls back to DEFAULT_TOP_K", async () => {
    prisma.tenantSetting.findUnique.mockRejectedValue(new Error("db exploded"));
    const topK = await settings.getRecommendationTopK({ tenantId: 1, subBrand: "tmc" });
    expect(topK).toBe(settings.DEFAULT_TOP_K);
  });
});

describe("diagnosticRecommendationSettings — setRecommendationTopK", () => {
  test("upserts the clamped value under the subBrand-scoped key", async () => {
    prisma.tenantSetting.upsert.mockResolvedValue({});
    const saved = await settings.setRecommendationTopK({ tenantId: 3, subBrand: "tmc", topK: 12 });
    expect(saved).toBe(12);
    const call = prisma.tenantSetting.upsert.mock.calls[0][0];
    expect(call.where).toEqual({ tenantId_key: { tenantId: 3, key: "travel.diagnostics.topK.tmc" } });
    expect(JSON.parse(call.create.value)).toEqual({ topK: 12 });
    expect(call.create.category).toBe(settings.CATEGORY);
  });

  test("clamps a value above MAX_TOP_K", async () => {
    prisma.tenantSetting.upsert.mockResolvedValue({});
    const saved = await settings.setRecommendationTopK({ tenantId: 1, subBrand: "tmc", topK: 500 });
    expect(saved).toBe(settings.MAX_TOP_K);
  });

  test("clamps a value below MIN_TOP_K", async () => {
    prisma.tenantSetting.upsert.mockResolvedValue({});
    const saved = await settings.setRecommendationTopK({ tenantId: 1, subBrand: "tmc", topK: 0 });
    expect(saved).toBe(settings.MIN_TOP_K);
  });

  test("throws a 400 for a non-numeric value", async () => {
    await expect(
      settings.setRecommendationTopK({ tenantId: 1, subBrand: "tmc", topK: "not-a-number" }),
    ).rejects.toMatchObject({ status: 400, code: "INVALID_TOP_K" });
    expect(prisma.tenantSetting.upsert).not.toHaveBeenCalled();
  });
});
