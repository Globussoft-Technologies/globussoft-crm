import { describe, expect, test, vi } from "vitest";
import { createRequire } from "node:module";

const requireCJS = createRequire(import.meta.url);
const { CONSENT_TEMPLATES, seedTmcConsentTemplates } = requireCJS("../../prisma/seed-tmc-consent-templates");

describe("TMC consent template seed", () => {
  test("upserts one database-backed source file for each trip type", async () => {
    const upsert = vi.fn().mockResolvedValue({});
    const prisma = { tmcConsentTemplate: { upsert } };

    const synced = await seedTmcConsentTemplates(prisma, 7);

    expect(synced).toBe(3);
    expect(upsert).toHaveBeenCalledTimes(3);
    for (const template of CONSENT_TEMPLATES) {
      expect(upsert).toHaveBeenCalledWith(expect.objectContaining({
        where: { tenantId_tripType: { tenantId: 7, tripType: template.tripType } },
        create: expect.objectContaining({
          tenantId: 7,
          tripType: template.tripType,
          filename: template.filename,
          mimeType: "application/pdf",
          fileBlob: expect.any(Buffer),
        }),
      }));
    }
  });
});
