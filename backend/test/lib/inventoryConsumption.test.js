import { describe, expect, test, vi } from "vitest";
import {
  buildPrescriptionConsumptionData,
  enrichConsumptionRow,
  normalizeInventoryUnit,
  syncPrescriptionConsumption,
  usagePricing,
} from "../../lib/inventoryConsumption.js";

describe("inventoryConsumption", () => {
  test("computes spreadsheet usage value from full product price and volume", () => {
    expect(usagePricing({ qty: 1, salePrice: 1885, volume: 50 })).toEqual({
      unitCost: 37.7,
      usageValue: 37.7,
    });
  });

  test("does not treat a numeric package size as the inventory unit", () => {
    expect(normalizeInventoryUnit("100", "other")).toBeNull();
    expect(normalizeInventoryUnit("100", "tablet")).toBe("tablet");
    expect(normalizeInventoryUnit("ml")).toBe("ml");
  });

  test("builds a prescription ledger line with source and catalogue metadata", () => {
    expect(buildPrescriptionConsumptionData({
      prescription: { id: 9, visitId: 80, tenantId: 3 },
      line: { name: "Amoxicillin", drugId: 12, qty: 2 },
      lineIndex: 0,
      drug: { id: 12, name: "Amoxicillin", salePrice: 25, productCode: "AMX-25", unit: "tablet" },
    })).toMatchObject({
      visitId: 80,
      tenantId: 3,
      productName: "Amoxicillin",
      qty: 2,
      unitCost: 25,
      usageValue: 50,
      salePrice: 25,
      sourceType: "PRESCRIPTION",
      transactionType: "Sale",
      productCode: "AMX-25",
      drugId: 12,
      prescriptionId: 9,
      prescriptionLine: 0,
    });
  });

  test("normalizes a numeric drug unit when creating a prescription consumption row", () => {
    expect(buildPrescriptionConsumptionData({
      prescription: { id: 9, visitId: 80, tenantId: 3 },
      line: { name: "Derma Facial Cream", drugId: 17, qty: 1 },
      lineIndex: 0,
      drug: { id: 17, name: "Derma Facial Cream", salePrice: 499, unit: "100", dosageForm: "other" },
    })).toMatchObject({ qty: 1, unit: null });
  });

  test("mirrors prescription lines once and updates the same lines on amendment", async () => {
    const client = {
      drug: {
        findMany: vi.fn().mockResolvedValue([
          { id: 12, name: "Amoxicillin", productCode: "AMX-25", salePrice: 25, unit: "tablet", dosageForm: "tablet" },
        ]),
      },
      serviceConsumption: {
        findMany: vi.fn().mockResolvedValue([]),
        create: vi.fn().mockResolvedValue({ id: 100 }),
        update: vi.fn(),
      },
    };
    const prescription = { id: 9, visitId: 80, tenantId: 3 };
    const first = await syncPrescriptionConsumption({
      client,
      prescription,
      drugs: [{ name: "Amoxicillin", drugId: 12, qty: 2 }],
    });
    expect(first).toEqual({ created: 1, updated: 0, skipped: 0 });
    expect(client.serviceConsumption.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ prescriptionLine: 0, qty: 2, usageValue: 50 }),
    });

    client.serviceConsumption.findMany.mockResolvedValue([{ id: 100, prescriptionLine: 0 }]);
    const second = await syncPrescriptionConsumption({
      client,
      prescription,
      drugs: [{ name: "Amoxicillin", drugId: 12, qty: 3 }],
    });
    expect(second).toEqual({ created: 0, updated: 1, skipped: 0 });
    expect(client.serviceConsumption.update).toHaveBeenCalledWith({
      where: { id: 100 },
      data: expect.objectContaining({ qty: 3, usageValue: 75 }),
    });
  });

  test("enriches a legacy row with the spreadsheet fields", () => {
    const row = enrichConsumptionRow({
      id: 1,
      visitId: 80,
      productId: 4,
      productName: "LE PROGRES Hair Growth Serum",
      qty: 1,
      unitCost: 37.7,
      salePrice: 0,
      createdAt: "2026-08-18T09:00:00.000Z",
    }, {
      visit: {
        id: 80,
        visitDate: "2026-08-18T08:00:00.000Z",
        patient: { name: "Faruk Sha" },
        doctor: { name: "Dr Priyambada" },
        service: { name: "Hair Therapy" },
      },
      product: {
        id: 4,
        productCode: "SERUM-50",
        price: 1885,
        volume: 50,
        unit: "ml",
      },
    });

    expect(row).toMatchObject({
      transactionDate: "2026-08-18T08:00:00.000Z",
      bookingId: 80,
      customerName: "Faruk Sha",
      staff: "Dr Priyambada",
      serviceName: "Hair Therapy",
      transactionType: "Sale",
      productCode: "SERUM-50",
      quantity: "1 ml",
      salePrice: 1885,
      usageValue: 37.7,
    });
  });

  test("repairs a legacy numeric unit without changing the consumed quantity", () => {
    const row = enrichConsumptionRow({
      id: 5,
      visitId: 232,
      drugId: 17,
      productName: "Derma Facial Cream",
      qty: 1,
      unit: "100",
      unitCost: 499,
      salePrice: 499,
    }, {
      drug: { id: 17, unit: "100", dosageForm: "other", salePrice: 499 },
    });

    expect(row).toMatchObject({ qty: 1, quantity: "1 unit", unit: "unit" });
    expect(row.quantity).not.toBe("1 100");
  });
});
