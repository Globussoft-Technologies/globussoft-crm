import { describe, expect, test, vi } from "vitest";
import {
  buildPrescriptionConsumptionData,
  enrichConsumptionRow,
  getVisitInventoryTotal,
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
        upsert: vi.fn().mockResolvedValue({ id: 100 }),
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
    };
    const prescription = { id: 9, visitId: 80, tenantId: 3 };
    const first = await syncPrescriptionConsumption({
      client,
      prescription,
      drugs: [{ name: "Amoxicillin", drugId: 12, qty: 2 }],
    });
    expect(first).toEqual({ created: 1, updated: 0, deactivated: 0, skipped: 0 });
    expect(client.serviceConsumption.upsert).toHaveBeenCalledWith({
      where: {
        tenantId_prescriptionId_prescriptionLine: {
          tenantId: 3,
          prescriptionId: 9,
          prescriptionLine: 0,
        },
      },
      create: expect.objectContaining({ prescriptionLine: 0, qty: 2, usageValue: 50, isActive: true }),
      update: expect.objectContaining({ prescriptionLine: 0, qty: 2, usageValue: 50, isActive: true }),
    });

    client.serviceConsumption.findMany.mockResolvedValue([{ id: 100, prescriptionLine: 0, isActive: true }]);
    const second = await syncPrescriptionConsumption({
      client,
      prescription,
      drugs: [{ name: "Amoxicillin", drugId: 12, qty: 3 }],
    });
    expect(second).toEqual({ created: 0, updated: 1, deactivated: 0, skipped: 0 });
    expect(client.serviceConsumption.upsert).toHaveBeenLastCalledWith(expect.objectContaining({
      update: expect.objectContaining({ qty: 3, usageValue: 75, isActive: true }),
    }));
  });

  test("voids removed prescription lines without deleting their audit rows", async () => {
    const client = {
      drug: { findMany: vi.fn().mockResolvedValue([]) },
      serviceConsumption: {
        findMany: vi.fn().mockResolvedValue([
          { id: 100, prescriptionLine: 0, isActive: true },
          { id: 101, prescriptionLine: 1, isActive: true },
        ]),
        upsert: vi.fn().mockResolvedValue({ id: 100 }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    };

    const result = await syncPrescriptionConsumption({
      client,
      prescription: { id: 9, visitId: 80, tenantId: 3 },
      drugs: [{ name: "Amoxicillin", qty: 1 }],
    });

    expect(result).toEqual({ created: 0, updated: 1, deactivated: 1, skipped: 0 });
    expect(client.serviceConsumption.updateMany).toHaveBeenCalledWith({
      where: { id: { in: [101] }, tenantId: 3, prescriptionId: 9 },
      data: { isActive: false, transactionType: "Voided" },
    });
  });

  test("totals only active inventory rows", async () => {
    const client = {
      serviceConsumption: {
        findMany: vi.fn().mockResolvedValue([
          { id: 1, qty: 2, unitCost: 25, usageValue: 50, productId: null, drugId: null },
        ]),
      },
    };

    await expect(getVisitInventoryTotal({ visitId: 80, tenantId: 3, client })).resolves.toBe(50);
    expect(client.serviceConsumption.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { visitId: 80, tenantId: 3, isActive: true },
    }));
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
