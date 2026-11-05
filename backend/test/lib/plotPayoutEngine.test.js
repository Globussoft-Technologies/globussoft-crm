const engine = require("../../lib/plotPayoutEngine");

describe("plotPayoutEngine", () => {
  const owners = [
    { partnerId: 11, ownershipBp: 6000, askedPricePaise: "120000000" },
    { partnerId: 12, ownershipBp: 4000, askedPricePaise: "80000000" },
  ];

  test("computes the PRD markup example with exact paise reconciliation", () => {
    const result = engine.computeEntitlements({
      basePricePaise: "200000000",
      listPricePaise: "240000000",
      finalPricePaise: "254400000",
      owners,
      channelPartnerId: 21,
      brokerPartnerId: 31,
      cpMarkupBp: 600,
      brokerRule: { ruleType: "PCT_LIST", rateBp: 100 },
      settings: { maxTotalCommissionBp: 1000, floorMarginPaise: 0 },
    });

    expect(result.cpMarkupPaise).toBe(12000000n);
    expect(result.brokerCommissionPaise).toBe(2400000n);
    expect(result.companySharePaise).toBe(40000000n);
    expect(engine.sumPaise(result.entitlements)).toBe(result.finalPricePaise);
  });

  test("splits a partial payment cumulatively and assigns rounding remainder exactly", () => {
    const result = engine.computeEntitlements({
      basePricePaise: 10003,
      listPricePaise: 10003,
      finalPricePaise: 10003,
      owners: [{ partnerId: 11, ownershipBp: 10000, askedPricePaise: 10003 }],
      brokerPartnerId: 31,
      brokerRule: { ruleType: "FLAT", flatPaise: 0 },
      settings: { maxTotalCommissionBp: 1000, floorMarginPaise: 0 },
    });
    const lines = engine.allocatePayment(3335, result.entitlements);
    expect(engine.sumPaise(lines)).toBe(3335n);
    expect(lines[lines.length - 1].amountPaise).toBeGreaterThanOrEqual(0n);
  });

  test("rejects an owner configuration whose shares do not total 100 percent", () => {
    expect(() => engine.computeEntitlements({
      basePricePaise: 10000,
      listPricePaise: 10000,
      finalPricePaise: 10000,
      owners: [{ partnerId: 11, ownershipBp: 9000, askedPricePaise: 10000 }],
      settings: {},
    })).toThrow(/10000/);
  });

  test("converts rupees without floating point drift", () => {
    expect(engine.rupeesToPaise("2544000.05")).toBe(254400005n);
    expect(engine.rupeesToPaise("20")).toBe(2000n);
  });

  test("accepts an exact custom split and preserves the company remainder", () => {
    const result = engine.computeCustomEntitlements({
      basePricePaise: 7000000,
      listPricePaise: 8000000,
      finalPricePaise: 8500000,
      lines: [
        { partyType: "OWNER", partnerId: 11, amountPaise: 7000000 },
        { partyType: "BROKER", partnerId: 31, amountPaise: 100000 },
        { partyType: "COMPANY", amountPaise: 1400000 },
      ],
    });
    expect(result.brokerCommissionPaise).toBe(100000n);
    expect(result.companySharePaise).toBe(1400000n);
    expect(engine.sumPaise(result.entitlements)).toBe(8500000n);
  });

  test("rejects a custom split that does not reconcile to the final price", () => {
    expect(() => engine.computeCustomEntitlements({
      finalPricePaise: 10000,
      lines: [{ partyType: "COMPANY", amountPaise: 9999 }],
    })).toThrow(/exactly equal/);
  });
});
