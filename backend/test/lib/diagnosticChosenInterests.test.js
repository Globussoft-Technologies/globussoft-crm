// @ts-check

import { describe, test, expect, beforeEach, vi } from "vitest";
import prisma from "../../lib/prisma.js";
import { createRequire } from "node:module";

const requireCJS = createRequire(import.meta.url);
const chosenInterests = requireCJS("../../lib/diagnosticChosenInterests");

prisma.tenantSetting = {
  ...(prisma.tenantSetting || {}),
  findUnique: vi.fn(),
  upsert: vi.fn(),
};

beforeEach(() => {
  prisma.tenantSetting.findUnique.mockReset();
  prisma.tenantSetting.upsert.mockReset();
});

describe("diagnosticChosenInterests — getChosenInterests", () => {
  test("returns null when no row exists", async () => {
    prisma.tenantSetting.findUnique.mockResolvedValue(null);
    const result = await chosenInterests.getChosenInterests({ tenantId: 1, diagnosticId: 515 });
    expect(result).toBeNull();
  });

  test("returns the stored interests + submittedAt", async () => {
    prisma.tenantSetting.findUnique.mockResolvedValue({
      value: JSON.stringify({
        interests: [{ name: "Hampi Heritage Trail", driveLink: "https://drive.example/hampi" }],
        submittedAt: "2026-08-27T10:00:00.000Z",
      }),
    });
    const result = await chosenInterests.getChosenInterests({ tenantId: 1, diagnosticId: 515 });
    expect(result).toEqual({
      interests: [{ name: "Hampi Heritage Trail", driveLink: "https://drive.example/hampi" }],
      submittedAt: "2026-08-27T10:00:00.000Z",
    });
  });

  test("queries by the diagnosticId-scoped key", async () => {
    prisma.tenantSetting.findUnique.mockResolvedValue(null);
    await chosenInterests.getChosenInterests({ tenantId: 4, diagnosticId: 42 });
    expect(prisma.tenantSetting.findUnique).toHaveBeenCalledWith({
      where: { tenantId_key: { tenantId: 4, key: "travel.diagnostic.interests.42" } },
    });
  });

  test("returns null for a corrupted (non-JSON) row instead of throwing", async () => {
    prisma.tenantSetting.findUnique.mockResolvedValue({ value: "not json" });
    const result = await chosenInterests.getChosenInterests({ tenantId: 1, diagnosticId: 1 });
    expect(result).toBeNull();
  });

  test("returns null when the stored interests normalize to empty (e.g. all blank names)", async () => {
    prisma.tenantSetting.findUnique.mockResolvedValue({
      value: JSON.stringify({ interests: [{ name: "   " }], submittedAt: "2026-08-27T10:00:00.000Z" }),
    });
    const result = await chosenInterests.getChosenInterests({ tenantId: 1, diagnosticId: 1 });
    expect(result).toBeNull();
  });
});

describe("diagnosticChosenInterests — saveChosenInterests", () => {
  test("upserts sanitized interests + a fresh submittedAt", async () => {
    prisma.tenantSetting.upsert.mockResolvedValue({});
    const saved = await chosenInterests.saveChosenInterests({
      tenantId: 4,
      diagnosticId: 515,
      interests: [{ name: "  Hampi Heritage Trail  ", driveLink: "https://drive.example/hampi" }],
    });
    expect(saved.interests).toEqual([{ name: "Hampi Heritage Trail", driveLink: "https://drive.example/hampi" }]);
    expect(saved.submittedAt).toBeTruthy();

    const call = prisma.tenantSetting.upsert.mock.calls[0][0];
    expect(call.where).toEqual({ tenantId_key: { tenantId: 4, key: "travel.diagnostic.interests.515" } });
    expect(call.create.category).toBe(chosenInterests.CATEGORY);
    expect(JSON.parse(call.create.value).interests).toEqual([
      { name: "Hampi Heritage Trail", driveLink: "https://drive.example/hampi" },
    ]);
  });

  test("drops entries with no name", async () => {
    prisma.tenantSetting.upsert.mockResolvedValue({});
    const saved = await chosenInterests.saveChosenInterests({
      tenantId: 1,
      diagnosticId: 1,
      interests: [{ name: "", driveLink: "x" }, { name: "Valid Trip" }],
    });
    expect(saved.interests).toEqual([{ name: "Valid Trip", driveLink: "" }]);
  });

  test("caps at MAX_INTERESTS entries", async () => {
    prisma.tenantSetting.upsert.mockResolvedValue({});
    const many = Array.from({ length: 30 }, (_, i) => ({ name: `Trip ${i}` }));
    const saved = await chosenInterests.saveChosenInterests({ tenantId: 1, diagnosticId: 1, interests: many });
    expect(saved.interests).toHaveLength(chosenInterests.MAX_INTERESTS);
  });

  test("throws a 400 when every interest is unusable (empty result)", async () => {
    await expect(
      chosenInterests.saveChosenInterests({ tenantId: 1, diagnosticId: 1, interests: [] }),
    ).rejects.toMatchObject({ status: 400, code: "MISSING_INTERESTS" });
    expect(prisma.tenantSetting.upsert).not.toHaveBeenCalled();
  });
});
