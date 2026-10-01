import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const migrationPath = fileURLToPath(new URL(
  "../../prisma/migrations/202610010900_wellness_inventory_billing/migration.sql",
  import.meta.url,
));

describe("wellness inventory billing migration", () => {
  const sql = readFileSync(migrationPath, "utf8");

  it("creates every Drug and ServiceConsumption column required by the Prisma schema", () => {
    for (const column of ["productCode", "salePrice", "unit"]) {
      expect(sql).toContain(`ADD COLUMN \`${column}\``);
    }
    for (const column of [
      "sourceType",
      "transactionType",
      "usageValue",
      "isActive",
      "drugId",
      "prescriptionId",
      "prescriptionLine",
    ]) {
      expect(sql).toContain(`ADD COLUMN \`${column}\``);
    }
  });

  it("enforces one prescription ledger row per tenant and source line", () => {
    expect(sql).toContain("ServiceConsumption_tenantId_prescriptionId_prescriptionLine_key");
    expect(sql).toContain("(`tenantId`, `prescriptionId`, `prescriptionLine`)");
  });

  it("adds nullable Drug and Prescription foreign keys with safe delete behavior", () => {
    expect(sql).toContain("FOREIGN KEY (`drugId`) REFERENCES `Drug`(`id`)");
    expect(sql).toContain("FOREIGN KEY (`prescriptionId`) REFERENCES `Prescription`(`id`)");
    expect(sql.match(/ON DELETE SET NULL ON UPDATE CASCADE/g)).toHaveLength(2);
  });
});
