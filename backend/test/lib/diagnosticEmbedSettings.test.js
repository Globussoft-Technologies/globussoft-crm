// @ts-check

import { describe, test, expect, beforeEach, vi } from "vitest";
import prisma from "../../lib/prisma.js";
import { createRequire } from "node:module";

const requireCJS = createRequire(import.meta.url);
const settings = requireCJS("../../lib/diagnosticEmbedSettings");

prisma.tenantSetting = {
  ...(prisma.tenantSetting || {}),
  findUnique: vi.fn(),
  upsert: vi.fn(),
};

beforeEach(() => {
  prisma.tenantSetting.findUnique.mockReset();
  prisma.tenantSetting.upsert.mockReset();
});

describe("diagnosticEmbedSettings — getEmbedConfig", () => {
  test("returns {} when no row exists", async () => {
    prisma.tenantSetting.findUnique.mockResolvedValue(null);
    const config = await settings.getEmbedConfig({ tenantId: 1, subBrand: "tmc" });
    expect(config).toEqual({});
  });

  test("returns the stored config when present", async () => {
    prisma.tenantSetting.findUnique.mockResolvedValue({ value: JSON.stringify({ primary: "#123456", title: "Hi" }) });
    const config = await settings.getEmbedConfig({ tenantId: 1, subBrand: "tmc" });
    expect(config).toEqual({ primary: "#123456", title: "Hi" });
  });

  test("queries by the tenantId + subBrand-scoped key, lower-cased", async () => {
    prisma.tenantSetting.findUnique.mockResolvedValue(null);
    await settings.getEmbedConfig({ tenantId: 7, subBrand: "TMC" });
    expect(prisma.tenantSetting.findUnique).toHaveBeenCalledWith({
      where: { tenantId_key: { tenantId: 7, key: "travel.diagnostics.embedConfig.tmc" } },
    });
  });

  test("falls back to {} on a corrupted (non-JSON) row", async () => {
    prisma.tenantSetting.findUnique.mockResolvedValue({ value: "not json" });
    const config = await settings.getEmbedConfig({ tenantId: 1, subBrand: "tmc" });
    expect(config).toEqual({});
  });

  test("falls back to {} when the stored value is not a plain object (e.g. an array)", async () => {
    prisma.tenantSetting.findUnique.mockResolvedValue({ value: JSON.stringify([1, 2, 3]) });
    const config = await settings.getEmbedConfig({ tenantId: 1, subBrand: "tmc" });
    expect(config).toEqual({});
  });

  test("never throws — a Prisma error also falls back to {}", async () => {
    prisma.tenantSetting.findUnique.mockRejectedValue(new Error("db exploded"));
    const config = await settings.getEmbedConfig({ tenantId: 1, subBrand: "tmc" });
    expect(config).toEqual({});
  });
});

describe("diagnosticEmbedSettings — setEmbedConfig", () => {
  test("upserts the config under the subBrand-scoped key", async () => {
    prisma.tenantSetting.upsert.mockResolvedValue({});
    const config = { primary: "#4f46e5", title: "TMC diagnostic" };
    const saved = await settings.setEmbedConfig({ tenantId: 3, subBrand: "tmc", config });
    expect(saved).toEqual(config);
    const call = prisma.tenantSetting.upsert.mock.calls[0][0];
    expect(call.where).toEqual({ tenantId_key: { tenantId: 3, key: "travel.diagnostics.embedConfig.tmc" } });
    expect(JSON.parse(call.create.value)).toEqual(config);
    expect(call.create.category).toBe(settings.CATEGORY);
    expect(call.update.category).toBe(settings.CATEGORY);
  });

  test("throws a 400 for a non-object config", async () => {
    await expect(
      settings.setEmbedConfig({ tenantId: 1, subBrand: "tmc", config: "not-an-object" }),
    ).rejects.toMatchObject({ status: 400, code: "INVALID_CONFIG" });
    expect(prisma.tenantSetting.upsert).not.toHaveBeenCalled();
  });

  test("throws a 400 for an array config", async () => {
    await expect(
      settings.setEmbedConfig({ tenantId: 1, subBrand: "tmc", config: [1, 2, 3] }),
    ).rejects.toMatchObject({ status: 400, code: "INVALID_CONFIG" });
  });

  test("throws a 400 when the config exceeds MAX_CONFIG_BYTES", async () => {
    const config = { blob: "x".repeat(settings.MAX_CONFIG_BYTES) };
    await expect(
      settings.setEmbedConfig({ tenantId: 1, subBrand: "tmc", config }),
    ).rejects.toMatchObject({ status: 400, code: "CONFIG_TOO_LARGE" });
    expect(prisma.tenantSetting.upsert).not.toHaveBeenCalled();
  });
});
