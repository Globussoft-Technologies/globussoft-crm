// @ts-check

import { describe, test, expect, beforeEach, vi } from "vitest";
import prisma from "../../lib/prisma.js";
import { createRequire } from "node:module";

const requireCJS = createRequire(import.meta.url);
const settings = requireCJS("../../lib/diagnosticNotificationSettings");

prisma.tenantSetting = {
  ...(prisma.tenantSetting || {}),
  findUnique: vi.fn(),
  upsert: vi.fn(),
};

beforeEach(() => {
  prisma.tenantSetting.findUnique.mockReset();
  prisma.tenantSetting.upsert.mockReset();
});

describe("diagnosticNotificationSettings — getNotificationRecipients", () => {
  test("returns [] when no row exists", async () => {
    prisma.tenantSetting.findUnique.mockResolvedValue(null);
    const out = await settings.getNotificationRecipients({ tenantId: 1, subBrand: "tmc" });
    expect(out).toEqual([]);
  });

  test("returns the stored recipients", async () => {
    prisma.tenantSetting.findUnique.mockResolvedValue({
      value: JSON.stringify({ recipients: [{ userId: 7, channels: ["db", "email"] }] }),
    });
    const out = await settings.getNotificationRecipients({ tenantId: 1, subBrand: "tmc" });
    expect(out).toEqual([{ userId: 7, channels: ["db", "email"] }]);
  });

  test("queries by the tenantId + subBrand-scoped key", async () => {
    prisma.tenantSetting.findUnique.mockResolvedValue(null);
    await settings.getNotificationRecipients({ tenantId: 9, subBrand: "rfu" });
    expect(prisma.tenantSetting.findUnique).toHaveBeenCalledWith({
      where: { tenantId_key: { tenantId: 9, key: "travel.diagnostics.notifyConfig.rfu" } },
    });
  });

  test("drops channels not in the allowed set", async () => {
    prisma.tenantSetting.findUnique.mockResolvedValue({
      value: JSON.stringify({ recipients: [{ userId: 1, channels: ["db", "sms", "carrier-pigeon"] }] }),
    });
    const out = await settings.getNotificationRecipients({ tenantId: 1, subBrand: "tmc" });
    expect(out).toEqual([{ userId: 1, channels: ["db"] }]);
  });

  test("drops a recipient whose channels normalize to empty", async () => {
    prisma.tenantSetting.findUnique.mockResolvedValue({
      value: JSON.stringify({ recipients: [{ userId: 1, channels: ["sms"] }, { userId: 2, channels: ["email"] }] }),
    });
    const out = await settings.getNotificationRecipients({ tenantId: 1, subBrand: "tmc" });
    expect(out).toEqual([{ userId: 2, channels: ["email"] }]);
  });

  test("returns [] for a corrupted (non-JSON) row instead of throwing", async () => {
    prisma.tenantSetting.findUnique.mockResolvedValue({ value: "not json" });
    const out = await settings.getNotificationRecipients({ tenantId: 1, subBrand: "tmc" });
    expect(out).toEqual([]);
  });

  test("never throws — a Prisma error also resolves to []", async () => {
    prisma.tenantSetting.findUnique.mockRejectedValue(new Error("db exploded"));
    const out = await settings.getNotificationRecipients({ tenantId: 1, subBrand: "tmc" });
    expect(out).toEqual([]);
  });
});

describe("diagnosticNotificationSettings — setNotificationRecipients", () => {
  test("upserts the normalized list under the subBrand-scoped key", async () => {
    prisma.tenantSetting.upsert.mockResolvedValue({});
    const saved = await settings.setNotificationRecipients({
      tenantId: 3,
      subBrand: "tmc",
      recipients: [{ userId: 5, channels: ["db", "whatsapp"] }],
    });
    expect(saved).toEqual([{ userId: 5, channels: ["db", "whatsapp"] }]);
    const call = prisma.tenantSetting.upsert.mock.calls[0][0];
    expect(call.where).toEqual({ tenantId_key: { tenantId: 3, key: "travel.diagnostics.notifyConfig.tmc" } });
    expect(JSON.parse(call.create.value)).toEqual({ recipients: [{ userId: 5, channels: ["db", "whatsapp"] }] });
    expect(call.create.category).toBe(settings.CATEGORY);
  });

  test("dedupes repeated userIds, keeping the first occurrence", async () => {
    prisma.tenantSetting.upsert.mockResolvedValue({});
    const saved = await settings.setNotificationRecipients({
      tenantId: 1,
      subBrand: "tmc",
      recipients: [{ userId: 5, channels: ["db"] }, { userId: 5, channels: ["email"] }],
    });
    expect(saved).toEqual([{ userId: 5, channels: ["db"] }]);
  });

  test("caps at MAX_RECIPIENTS entries", async () => {
    prisma.tenantSetting.upsert.mockResolvedValue({});
    const many = Array.from({ length: 40 }, (_, i) => ({ userId: i + 1, channels: ["db"] }));
    const saved = await settings.setNotificationRecipients({ tenantId: 1, subBrand: "tmc", recipients: many });
    expect(saved).toHaveLength(settings.MAX_RECIPIENTS);
  });

  test("saving an empty list clears the config (allowed — falls back to default behavior)", async () => {
    prisma.tenantSetting.upsert.mockResolvedValue({});
    const saved = await settings.setNotificationRecipients({ tenantId: 1, subBrand: "tmc", recipients: [] });
    expect(saved).toEqual([]);
    expect(prisma.tenantSetting.upsert).toHaveBeenCalled();
  });
});
