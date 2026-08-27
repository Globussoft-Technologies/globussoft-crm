// @ts-check
/**
 * Unit tests for backend/lib/drugStock.js.
 *
 * Stock lives on the drug catalogue itself: the clinic dispenses from the same
 * shelf the doctor prescribes off, so `Drug.quantity` IS the ledger.
 *
 * Two invariants carry the most weight:
 *
 *   1. `not_in_catalogue` is NOT `out`. A medicine typed as free text has
 *      UNKNOWN stock; showing it as zero would tell a doctor the clinic has
 *      none of something it may have plenty of.
 *
 *   2. A prescription line with no quantity dispenses ONE unit, never zero.
 *      Measured on a live tenant, doctors leave dosage/frequency/duration
 *      blank on 99% of lines (151 of 152), so a derived course total would
 *      decrement nothing almost every time — and 150,500 on the one line that
 *      had them, because `dosage` holds the strength in mg, not a count.
 */

import { describe, test, expect, beforeEach, vi } from "vitest";
import { createRequire } from "node:module";

const requireCJS = createRequire(import.meta.url);
const prisma = requireCJS("../../lib/prisma");

prisma.drug = prisma.drug || {};
prisma.drug.findMany = vi.fn();
prisma.drug.update = vi.fn();
prisma.user = prisma.user || {};
prisma.user.findMany = vi.fn();
prisma.user.findUnique = vi.fn();
prisma.notification = prisma.notification || {};
prisma.notification.create = vi.fn();
prisma.notification.findFirst = vi.fn();
prisma.notificationPreference = prisma.notificationPreference || {};
prisma.notificationPreference.findUnique = vi.fn();

const {
  STOCK_STATE,
  DEFAULT_DISPENSE_UNITS,
  MAX_DISPENSE_UNITS,
  normalizeName,
  stripStrength,
  stockStateForDrug,
  buildDrugIndex,
  matchDrugRow,
  dispenseUnitsFor,
  resolveStockForDrugs,
  summarizeStock,
  applyPrescriptionStock,
} = requireCJS("../../lib/drugStock");

beforeEach(() => {
  vi.clearAllMocks();
  prisma.drug.findMany.mockResolvedValue([]);
  prisma.user.findMany.mockResolvedValue([]);
  prisma.user.findUnique.mockResolvedValue(null);
  prisma.notification.create.mockResolvedValue({ id: 1 });
  prisma.notification.findFirst.mockResolvedValue(null);
  prisma.notificationPreference.findUnique.mockResolvedValue(null);
});

// ─────────────────────────────────────────────────────────────────────────
// stockStateForDrug
// ─────────────────────────────────────────────────────────────────────────

describe("stockStateForDrug", () => {
  test("a drug the catalogue has never seen is NOT_IN_CATALOGUE, never OUT", () => {
    const r = stockStateForDrug(null);
    expect(r.state).toBe(STOCK_STATE.NOT_IN_CATALOGUE);
    expect(r.quantity).toBeNull();
    expect(r.state).not.toBe(STOCK_STATE.OUT);
  });

  test("above the reorder point is IN_STOCK", () => {
    expect(stockStateForDrug({ quantity: 40, lowStockThreshold: 10 }).state).toBe(
      STOCK_STATE.IN_STOCK,
    );
  });

  test("at or below the reorder point is LOW", () => {
    expect(stockStateForDrug({ quantity: 10, lowStockThreshold: 10 }).state).toBe(STOCK_STATE.LOW);
    expect(stockStateForDrug({ quantity: 3, lowStockThreshold: 10 }).state).toBe(STOCK_STATE.LOW);
  });

  test("zero or below is OUT, even when the drug isn't tracked", () => {
    expect(stockStateForDrug({ quantity: 0, lowStockThreshold: 10 }).state).toBe(STOCK_STATE.OUT);
    expect(stockStateForDrug({ quantity: -2, lowStockThreshold: 10 }).state).toBe(STOCK_STATE.OUT);
    expect(stockStateForDrug({ quantity: 0, lowStockThreshold: 0 }).state).toBe(STOCK_STATE.OUT);
  });

  test("threshold 0 with stock on hand is NOT_TRACKED, not IN_STOCK", () => {
    // Same convention as Product.threshold / lowStockEngine: 0 means the
    // clinic isn't managing this one, so we don't claim it's fine.
    const r = stockStateForDrug({ quantity: 12, lowStockThreshold: 0 });
    expect(r.state).toBe(STOCK_STATE.NOT_TRACKED);
    expect(r.quantity).toBe(12);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Matching a prescribed line back to the catalogue
// ─────────────────────────────────────────────────────────────────────────

describe("matchDrugRow", () => {
  const index = buildDrugIndex([
    { id: 96, name: "Minoxidil", quantity: 6, lowStockThreshold: 5 },
    { id: 13, name: "Amoxicillin", quantity: 40, lowStockThreshold: 10 },
  ]);

  test("a stamped drugId wins over the typed name", () => {
    expect(matchDrugRow({ drugId: 96, name: "something else" }, index).id).toBe(96);
  });

  test("ignores the empty-string drugId the writer stores when unpicked", () => {
    expect(matchDrugRow({ drugId: "", name: "Minoxidil" }, index).id).toBe(96);
  });

  test("falls back to the strength-stripped name", () => {
    expect(matchDrugRow({ name: "Minoxidil 5%" }, index).id).toBe(96);
    expect(matchDrugRow({ name: "Amoxicillin 500mg" }, index).id).toBe(13);
  });

  test("returns null for free text rather than a nearest guess", () => {
    expect(matchDrugRow({ name: "Paracetamol" }, index)).toBeNull();
  });

  test("normalisation keeps % but folds case and spacing", () => {
    expect(normalizeName("  MINOXIDIL  5% ")).toBe("minoxidil 5%");
    expect(stripStrength("minoxidil 5%")).toBe("minoxidil");
    // A number that is part of the name is not a dose.
    expect(stripStrength("b3 serum")).toBe("b3 serum");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// dispenseUnitsFor — the rule the whole feature rests on
// ─────────────────────────────────────────────────────────────────────────

describe("dispenseUnitsFor", () => {
  test("blank dispenses ONE, not zero", () => {
    // 99% of real lines carry nothing. Defaulting to 0 would make stock never
    // move and the feature look broken.
    expect(dispenseUnitsFor({})).toBe(DEFAULT_DISPENSE_UNITS);
    expect(dispenseUnitsFor({ qty: "" })).toBe(1);
    expect(dispenseUnitsFor({ qty: null })).toBe(1);
    expect(dispenseUnitsFor(null)).toBe(1);
  });

  test("an explicit quantity is honoured — the doctor writes 2 units", () => {
    expect(dispenseUnitsFor({ qty: 2 })).toBe(2);
    expect(dispenseUnitsFor({ qty: "3" })).toBe(3);
  });

  test("junk, zero and negatives fall back to one rather than to zero", () => {
    for (const bad of [0, -5, 1.5, "lots", {}]) {
      expect(dispenseUnitsFor({ qty: bad })).toBe(1);
    }
  });

  test("caps an absurd quantity instead of draining the shelf", () => {
    expect(dispenseUnitsFor({ qty: 999999 })).toBe(MAX_DISPENSE_UNITS);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// resolveStockForDrugs
// ─────────────────────────────────────────────────────────────────────────

describe("resolveStockForDrugs", () => {
  test("one entry per input, in order, with unknowns kept distinct from out", async () => {
    prisma.drug.findMany.mockResolvedValue([
      { id: 96, name: "Minoxidil", quantity: 6, lowStockThreshold: 25, isActive: true },
      { id: 13, name: "Amoxicillin", quantity: 0, lowStockThreshold: 10, isActive: true },
    ]);

    const out = await resolveStockForDrugs({
      tenantId: 1,
      drugs: [{ name: "Minoxidil 5%" }, { name: "Amoxicillin 500mg" }, { name: "Paracetamol" }],
    });

    expect(out.map((e) => e.state)).toEqual([
      STOCK_STATE.LOW,
      STOCK_STATE.OUT,
      STOCK_STATE.NOT_IN_CATALOGUE,
    ]);
    expect(out[0].quantity).toBe(6);
    expect(out[2].quantity).toBeNull();
  });

  test("reads the catalogue once regardless of how many lines", async () => {
    prisma.drug.findMany.mockResolvedValue([]);
    await resolveStockForDrugs({
      tenantId: 1,
      drugs: [{ name: "a" }, { name: "b" }, { name: "c" }, { name: "d" }],
    });
    expect(prisma.drug.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.drug.findMany.mock.calls[0][0].where).toEqual({ tenantId: 1 });
  });

  test("flags a deactivated drug rather than hiding it", async () => {
    prisma.drug.findMany.mockResolvedValue([
      { id: 1, name: "Retired", quantity: 9, lowStockThreshold: 2, isActive: false },
    ]);
    const [entry] = await resolveStockForDrugs({ tenantId: 1, drugs: [{ name: "Retired" }] });
    expect(entry.drugInactive).toBe(true);
    expect(entry.state).toBe(STOCK_STATE.IN_STOCK);
  });

  test("an empty list short-circuits without querying", async () => {
    expect(await resolveStockForDrugs({ tenantId: 1, drugs: [] })).toEqual([]);
    expect(prisma.drug.findMany).not.toHaveBeenCalled();
  });
});

describe("summarizeStock", () => {
  const e = (state) => ({ state });

  test("out dominates, then low", () => {
    expect(summarizeStock([e("in_stock"), e("low"), e("out")]).summary).toBe("out");
    expect(summarizeStock([e("in_stock"), e("low")]).summary).toBe("low");
  });

  test("a partly-unknown set is 'partial', never 'available'", () => {
    expect(summarizeStock([e("in_stock"), e("not_in_catalogue")]).summary).toBe("partial");
  });

  test("an entirely unknown set is 'unknown'", () => {
    expect(summarizeStock([e("not_in_catalogue")]).summary).toBe("unknown");
    expect(summarizeStock([]).summary).toBe("unknown");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// applyPrescriptionStock — the decrement
// ─────────────────────────────────────────────────────────────────────────

describe("applyPrescriptionStock", () => {
  const catalogue = [
    { id: 96, name: "Minoxidil", quantity: 40, lowStockThreshold: 10 },
    { id: 13, name: "Amoxicillin", quantity: 5, lowStockThreshold: 10 },
  ];

  beforeEach(() => {
    prisma.drug.findMany.mockResolvedValue(catalogue);
    prisma.drug.update.mockImplementation(async ({ where, data }) => {
      const row = catalogue.find((d) => d.id === where.id);
      return { ...row, quantity: row.quantity - data.quantity.decrement };
    });
  });

  test("takes one unit off per line by default", async () => {
    const out = await applyPrescriptionStock({
      tenantId: 1,
      drugs: [{ name: "Minoxidil 5%" }],
    });
    expect(prisma.drug.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 96 },
        data: { quantity: { decrement: 1 } },
      }),
    );
    expect(out.adjusted[0]).toMatchObject({ name: "Minoxidil", units: 1, quantityAfter: 39 });
  });

  test("honours an explicit qty — the doctor writes 2 units", async () => {
    await applyPrescriptionStock({ tenantId: 1, drugs: [{ name: "Minoxidil", qty: 2 }] });
    expect(prisma.drug.update.mock.calls[0][0].data).toEqual({ quantity: { decrement: 2 } });
  });

  test("uses `decrement` so concurrent saves both land", async () => {
    // A read-modify-write would let the second prescription overwrite the
    // first's result; a relative decrement cannot.
    await applyPrescriptionStock({ tenantId: 1, drugs: [{ name: "Minoxidil" }] });
    expect(prisma.drug.update.mock.calls[0][0].data.quantity).toHaveProperty("decrement");
  });

  test("collapses the same drug listed twice into one update", async () => {
    await applyPrescriptionStock({
      tenantId: 1,
      drugs: [{ name: "Minoxidil", qty: 2 }, { name: "Minoxidil 5%", qty: 3 }],
    });
    expect(prisma.drug.update).toHaveBeenCalledTimes(1);
    expect(prisma.drug.update.mock.calls[0][0].data).toEqual({ quantity: { decrement: 5 } });
  });

  test("reports free text back untouched instead of inventing stock", async () => {
    const out = await applyPrescriptionStock({
      tenantId: 1,
      drugs: [{ name: "Paracetamol" }, { name: "Minoxidil" }],
    });
    expect(out.unmatched).toEqual(["Paracetamol"]);
    expect(out.adjusted).toHaveLength(1);
    expect(prisma.drug.update).toHaveBeenCalledTimes(1);
  });

  test("notifies admins when a drug CROSSES its reorder point", async () => {
    prisma.user.findMany.mockResolvedValue([{ id: 1 }, { id: 2 }]);
    // 40 → 10 with a threshold of 10 is a crossing.
    await applyPrescriptionStock({ tenantId: 1, drugs: [{ name: "Minoxidil", qty: 30 }] });

    const titles = prisma.notification.create.mock.calls.map((c) => c[0].data.title);
    expect(titles.length).toBe(2);
    expect(titles[0]).toMatch(/running low/i);
    expect(prisma.notification.create.mock.calls[0][0].data.entityType).toBe("drug-stock");
  });

  test("does NOT re-notify for a drug that was already below the point", async () => {
    prisma.user.findMany.mockResolvedValue([{ id: 1 }]);
    // Amoxicillin starts at 5 with a threshold of 10 — already low. Taking one
    // more off is not a new crossing, so it must stay quiet or every
    // prescription would re-alert.
    await applyPrescriptionStock({ tenantId: 1, drugs: [{ name: "Amoxicillin", qty: 1 }] });
    expect(prisma.notification.create).not.toHaveBeenCalled();
  });

  test("always notifies when a drug hits zero, tracked or not", async () => {
    prisma.user.findMany.mockResolvedValue([{ id: 1 }]);
    await applyPrescriptionStock({ tenantId: 1, drugs: [{ name: "Amoxicillin", qty: 5 }] });
    const titles = prisma.notification.create.mock.calls.map((c) => c[0].data.title);
    expect(titles[0]).toMatch(/out of stock/i);
  });

  test("one drug failing does not abandon the rest", async () => {
    prisma.drug.update
      .mockRejectedValueOnce(new Error("row locked"))
      .mockImplementationOnce(async () => ({
        id: 13, name: "Amoxicillin", quantity: 4, lowStockThreshold: 10,
      }));

    const out = await applyPrescriptionStock({
      tenantId: 1,
      drugs: [{ name: "Minoxidil" }, { name: "Amoxicillin" }],
    });
    expect(out.adjusted).toHaveLength(1);
    expect(out.adjusted[0].name).toBe("Amoxicillin");
  });

  test("an empty prescription is a no-op", async () => {
    const out = await applyPrescriptionStock({ tenantId: 1, drugs: [] });
    expect(out).toEqual({ adjusted: [], unmatched: [] });
    expect(prisma.drug.update).not.toHaveBeenCalled();
  });
});
