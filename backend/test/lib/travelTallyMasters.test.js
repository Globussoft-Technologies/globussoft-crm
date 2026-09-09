import { describe, expect, it } from "vitest";
const {
  ensurePartyLedger,
  ensureServiceLedgers,
  enqueueTransaction,
  buildVoucherLines,
  resolveBillAllocation,
  sourceKey,
} = require("../../lib/travelTallyMasters");

function fakePrisma() {
  const ledgers = [];
  const mappings = [];
  const queue = [];
  return {
    ledgers,
    mappings,
    queue,
    travelTallyLedger: {
      findUnique: async ({ where }) => {
        const key = where.tenantId_subBrand_sourceKey;
        return ledgers.find((row) => row.tenantId === key.tenantId && row.subBrand === key.subBrand && row.sourceKey === key.sourceKey) || null;
      },
      create: async ({ data }) => {
        const row = { id: ledgers.length + 1, ...data };
        ledgers.push(row);
        return row;
      },
    },
    travelTallyMapping: {
      findFirst: async ({ where }) => mappings.find((row) => row.tenantId === where.tenantId && row.subBrand === where.subBrand && row.sourceType === where.sourceType && row.sourceKey === where.sourceKey && row.transactionType === where.transactionType) || null,
      update: async ({ where, data }) => {
        const found = mappings.find((row) => row.id === where.id);
        Object.assign(found, data);
        return found;
      },
      create: async ({ data }) => {
        const row = { id: mappings.length + 1, ...data };
        mappings.push(row);
        return row;
      },
    },
    travelTallySyncQueue: {
      upsert: async ({ where, update, create }) => {
        const key = where.tenantId_sourceType_sourceId_transactionType;
        const found = queue.find((row) => row.tenantId === key.tenantId && row.sourceType === key.sourceType && row.sourceId === key.sourceId && row.transactionType === key.transactionType);
        if (found) Object.assign(found, update);
        else queue.push({ id: queue.length + 1, ...create });
        return found || queue[queue.length - 1];
      },
    },
  };
}

describe("travel Tally masters", () => {
  it("creates a party ledger and default mapping idempotently", async () => {
    const db = fakePrisma();
    const first = await ensurePartyLedger({
      prismaClient: db,
      tenantId: 7,
      subBrand: "tmc",
      partyType: "SUPPLIER",
      partyId: 42,
      name: "ABC Flights",
    });
    const second = await ensurePartyLedger({
      prismaClient: db,
      tenantId: 7,
      subBrand: "tmc",
      partyType: "SUPPLIER",
      partyId: 42,
      name: "ABC Flights",
    });

    expect(first.id).toBe(second.id);
    expect(db.ledgers).toHaveLength(1);
    expect(db.mappings).toHaveLength(1);
    expect(db.mappings[0].transactionType).toBe("PURCHASE");
  });

  it("creates both sales and purchase ledgers for a service type", async () => {
    const db = fakePrisma();
    const result = await ensureServiceLedgers({
      prismaClient: db,
      tenantId: 7,
      subBrand: "rfu",
      serviceType: "Hotel Stay",
    });

    expect(result.sales.ledgerName).toBe("Hotel Stay Sales");
    expect(result.purchase.ledgerName).toBe("Hotel Stay Purchase");
    expect(db.mappings.map((row) => row.transactionType).sort()).toEqual(["PURCHASE", "SALES"]);
  });

  it("uses stable source keys", () => {
    expect(sourceKey("service", "hotel-stay")).toBe("SERVICE:hotel-stay");
  });

  it("keeps prepared transactions idempotent", async () => {
    const db = fakePrisma();
    await enqueueTransaction({
      prismaClient: db,
      tenantId: 7,
      subBrand: "tmc",
      sourceType: "TRAVEL_INVOICE",
      sourceId: 12,
      reference: "TINV-2026-0012",
      transactionType: "SALES",
      amount: "1500.00",
      voucherType: "SALES",
      payload: { invoiceId: 12 },
    });
    await enqueueTransaction({
      prismaClient: db,
      tenantId: 7,
      subBrand: "tmc",
      sourceType: "TRAVEL_INVOICE",
      sourceId: 12,
      reference: "TINV-2026-0012",
      transactionType: "SALES",
      amount: "1500.00",
      voucherType: "SALES",
      payload: { invoiceId: 12 },
    });
    expect(db.queue).toHaveLength(1);
    expect(db.queue[0].status).toBe("PENDING");
  });

  it("builds balanced debit and credit preview lines", () => {
    const lines = buildVoucherLines({ transactionType: "SALES", partyName: "Rahul", amount: 118000 });
    expect(lines[0]).toMatchObject({ ledger: "Rahul", debit: 118000, credit: 0 });
    expect(lines.reduce((sum, line) => sum + line.debit, 0)).toBe(118000);
    expect(lines.reduce((sum, line) => sum + line.credit, 0)).toBe(118000);
  });

  it("allocates a linked receipt against the existing sales bill", () => {
    expect(resolveBillAllocation({
      transactionType: "RECEIPT",
      billReference: "SAL-0001",
      billExists: true,
      amount: 246750.90,
    })).toEqual({ name: "SAL-0001", billType: "Agst Ref", amount: 246750.90, onAccount: false });
  });

  it("allocates a linked payment against the existing purchase bill without changing its sign", () => {
    expect(resolveBillAllocation({
      transactionType: "PAYMENT",
      billReference: "PUR-0003",
      billExists: true,
      amount: -20000,
    })).toEqual({ name: "PUR-0003", billType: "Agst Ref", amount: -20000, onAccount: false });
  });

  it("uses On Account only when no bill reference is provided", () => {
    expect(resolveBillAllocation({ transactionType: "RECEIPT", amount: 100 })).toMatchObject({
      name: "On Account", billType: "On Account", onAccount: true,
    });
  });

  it("rejects a reference that is not present", () => {
    expect(() => resolveBillAllocation({ transactionType: "PAYMENT", billReference: "PUR-MISSING" })).toThrow("PUR-MISSING");
  });
});
