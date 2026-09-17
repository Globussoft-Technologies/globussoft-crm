import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const migrationPath = fileURLToPath(new URL(
  "../../prisma/migrations/202609171700_expand_tally_cost_centres/migration.sql",
  import.meta.url,
));

describe("Travel Tally cost-centre migration", () => {
  const sql = readFileSync(migrationPath, "utf8");

  it("backfills the source discriminator before making sourceId required", () => {
    const backfill = sql.indexOf("SET `sourceType` = 'ITINERARY', `sourceId` = `itineraryId`");
    const makeRequired = sql.indexOf("MODIFY `sourceId` INTEGER NOT NULL");

    expect(backfill).toBeGreaterThan(-1);
    expect(makeRequired).toBeGreaterThan(backfill);
  });

  it("adds unique source identity and cascading relations for each new source", () => {
    expect(sql).toContain("`TravelTallyCostCentre_tenantId_sourceType_sourceId_key`");
    expect(sql).toContain("FOREIGN KEY (`tmcTripId`) REFERENCES `TmcTrip` (`id`) ON DELETE CASCADE");
    expect(sql).toContain("FOREIGN KEY (`quoteId`) REFERENCES `TravelQuote` (`id`) ON DELETE CASCADE");
  });
});
