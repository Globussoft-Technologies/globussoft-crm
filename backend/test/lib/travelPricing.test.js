// Unit tests for backend/lib/travelPricing.js
//
// Pins the deterministic pricing-engine math. Same (cost, seasons,
// rules, subBrand, tripDate) → same QuoteResult, every time. This is
// the load-bearing audit invariant: a refund-dispute case opened a
// year after the trip should be able to recompute the same grand-
// total against the same snapshot rows.

import { describe, test, expect } from "vitest";

const { quote, pickSeason, pickMarkup, mapCategoryToScope } = await import(
  "../../lib/travelPricing.js"
);

const HOTEL_COST = {
  baseRate: 10000,
  category: "hotel",
  subBrand: "rfu",
  routeOrSku: "Makkah:Hilton",
};

const SEASONS = [
  {
    subBrand: "rfu",
    seasonName: "ramadan-peak",
    startDate: "2026-03-01",
    endDate: "2026-04-15",
    multiplier: 2.0,
    isActive: true,
  },
  {
    subBrand: "rfu",
    seasonName: "school-holiday",
    startDate: "2026-06-01",
    endDate: "2026-07-15",
    multiplier: 1.3,
    isActive: true,
  },
  {
    subBrand: "rfu",
    seasonName: "lean",
    startDate: "2026-08-01",
    endDate: "2026-09-30",
    multiplier: 0.85,
    isActive: true,
  },
];

const RULES = [
  {
    id: 1,
    subBrand: "rfu",
    scope: "hotel",
    matchKeyJson: "{}",
    markupPct: 10,
    markupFlat: null,
    ownerUserId: null,
    priority: 100,
    isActive: true,
  },
  {
    id: 2,
    subBrand: "rfu",
    scope: "hotel",
    matchKeyJson: "{}",
    markupPct: null,
    markupFlat: 2500,
    ownerUserId: 42, // per-agent rule
    priority: 50,
    isActive: true,
  },
  {
    id: 3,
    subBrand: "rfu",
    scope: "hotel",
    matchKeyJson: "{}",
    markupPct: 5,
    markupFlat: null,
    ownerUserId: null,
    priority: 200, // lower priority than rule 1 (higher number)
    isActive: true,
  },
];

// ─── pickSeason ──────────────────────────────────────────────────────

describe("pickSeason", () => {
  test("returns multiplier 1.0 + null when no season matches", () => {
    expect(pickSeason(SEASONS, "2026-12-25", "rfu")).toEqual({
      multiplier: 1.0,
      matchedSeasonName: null,
    });
  });

  test("picks the only matching season", () => {
    expect(pickSeason(SEASONS, "2026-03-15", "rfu")).toEqual({
      multiplier: 2.0,
      matchedSeasonName: "ramadan-peak",
    });
  });

  test("on overlap, picks the FIRST eligible row (authors curate via array order)", () => {
    // ramadan-peak (2.0) is first in SEASONS — a 1.5x season added
    // afterward must NOT override it.
    const overlapping = [
      ...SEASONS,
      {
        subBrand: "rfu",
        seasonName: "school-leavers",
        startDate: "2026-03-01",
        endDate: "2026-04-15",
        multiplier: 1.5,
        isActive: true,
      },
    ];
    expect(pickSeason(overlapping, "2026-03-15", "rfu").matchedSeasonName).toBe("ramadan-peak");
    // Conversely: if school-leavers comes FIRST in the array, it wins.
    expect(
      pickSeason(
        [
          { subBrand: "rfu", seasonName: "school-leavers", startDate: "2026-03-01", endDate: "2026-04-15", multiplier: 1.5, isActive: true },
          ...SEASONS,
        ],
        "2026-03-15",
        "rfu",
      ).matchedSeasonName,
    ).toBe("school-leavers");
  });

  test("a lean season with multiplier < 1.0 IS applied (discount, not skipped)", () => {
    // This was the original bug — "highest wins" silently skipped
    // 0.85 because 1.0 (the fallback) was higher.
    expect(pickSeason(SEASONS, "2026-08-15", "rfu")).toEqual({
      multiplier: 0.85,
      matchedSeasonName: "lean",
    });
  });

  test("ignores rows from a different sub-brand", () => {
    const tmcSeasons = [
      { subBrand: "tmc", seasonName: "tmc-only", startDate: "2026-03-01", endDate: "2026-04-15", multiplier: 5.0, isActive: true },
    ];
    expect(pickSeason(tmcSeasons, "2026-03-15", "rfu").multiplier).toBe(1.0);
  });

  test("ignores inactive rows", () => {
    const inactive = SEASONS.map((s) => ({ ...s, isActive: false }));
    expect(pickSeason(inactive, "2026-03-15", "rfu").multiplier).toBe(1.0);
  });
});

// ─── pickMarkup ──────────────────────────────────────────────────────

describe("pickMarkup", () => {
  test("picks the highest-priority (lowest number) active rule", () => {
    // Caller is NOT acting as user 42, so rule #2 (per-agent) is filtered.
    // Rule #1 (priority 100) beats rule #3 (priority 200).
    const res = pickMarkup(RULES, "rfu", "hotel", 20000);
    expect(res.rule.id).toBe(1);
    expect(res.markupAmount).toBe(2000); // 10% of 20k
  });

  test("uses the per-agent rule when ownerUserId matches", () => {
    const res = pickMarkup(RULES, "rfu", "hotel", 20000, 42);
    expect(res.rule.id).toBe(2); // priority 50 (best) + matches owner
    expect(res.markupAmount).toBe(2500); // flat
  });

  test("returns {rule: null, markupAmount: 0} when nothing matches", () => {
    const res = pickMarkup(RULES, "rfu", "transport", 20000);
    expect(res.rule).toBeNull();
    expect(res.markupAmount).toBe(0);
  });

  test("rounds markup to 2 decimal places", () => {
    const rules = [
      {
        id: 99,
        subBrand: "rfu",
        scope: "hotel",
        markupPct: 1.234567,
        ownerUserId: null,
        priority: 100,
        isActive: true,
      },
    ];
    const res = pickMarkup(rules, "rfu", "hotel", 10000);
    expect(res.markupAmount).toBe(123.46); // not 123.4567
  });

  test("ignores inactive rules", () => {
    const rules = RULES.map((r) => ({ ...r, isActive: false }));
    const res = pickMarkup(rules, "rfu", "hotel", 20000);
    expect(res.rule).toBeNull();
  });
});

// ─── mapCategoryToScope ──────────────────────────────────────────────

describe("mapCategoryToScope", () => {
  test("hotel / flight / transport pass through", () => {
    expect(mapCategoryToScope("hotel")).toBe("hotel");
    expect(mapCategoryToScope("flight")).toBe("flight");
    expect(mapCategoryToScope("transport")).toBe("transport");
  });

  test("visa and insurance fold into 'package'", () => {
    expect(mapCategoryToScope("visa")).toBe("package");
    expect(mapCategoryToScope("insurance")).toBe("package");
  });

  test("missing/unknown falls back to 'package'", () => {
    expect(mapCategoryToScope(null)).toBe("package");
    expect(mapCategoryToScope(undefined)).toBe("package");
  });
});

// ─── quote (full composition) ────────────────────────────────────────

describe("quote", () => {
  test("no season + no markup → grandTotal == baseRate", () => {
    const res = quote({
      cost: HOTEL_COST,
      seasons: [],
      rules: [],
      subBrand: "rfu",
      tripDate: "2026-05-15",
    });
    expect(res.baseRate).toBe(10000);
    expect(res.seasonMultiplier).toBe(1.0);
    expect(res.markupAmount).toBe(0);
    expect(res.grandTotal).toBe(10000);
  });

  test("ramadan-peak (2x) + 10% markup → 22000", () => {
    const res = quote({
      cost: HOTEL_COST,
      seasons: SEASONS,
      rules: RULES,
      subBrand: "rfu",
      tripDate: "2026-03-20",
    });
    expect(res.matchedSeasonName).toBe("ramadan-peak");
    expect(res.seasonMultiplier).toBe(2.0);
    expect(res.subtotal).toBe(20000);    // 10000 * 2
    expect(res.markupAmount).toBe(2000); // 10% of 20k
    expect(res.grandTotal).toBe(22000);
    expect(res.matchedMarkupRuleId).toBe(1);
  });

  test("lean season (0.85x) + flat markup for owner-42 → 11000", () => {
    const res = quote({
      cost: HOTEL_COST,
      seasons: SEASONS,
      rules: RULES,
      subBrand: "rfu",
      tripDate: "2026-08-15",
      ownerUserId: 42,
    });
    expect(res.matchedSeasonName).toBe("lean");
    expect(res.seasonMultiplier).toBe(0.85);
    expect(res.subtotal).toBe(8500);     // 10000 * 0.85
    expect(res.markupAmount).toBe(2500); // flat from rule #2
    expect(res.grandTotal).toBe(11000);
  });

  test("warnings: no-season + no-markup for off-season + uncovered scope", () => {
    const res = quote({
      cost: { ...HOTEL_COST, category: "transport" },
      seasons: SEASONS, // none cover Dec 25
      rules: RULES,     // none scope=transport
      subBrand: "rfu",
      tripDate: "2026-12-25",
    });
    expect(res.warnings).toContain("no-season-matched:rfu:2026-12-25");
    expect(res.warnings).toContain("no-markup-rule-matched:rfu:transport");
    expect(res.grandTotal).toBe(10000); // raw baseRate
  });

  test("determinism — same inputs → identical outputs", () => {
    const input = {
      cost: HOTEL_COST,
      seasons: SEASONS,
      rules: RULES,
      subBrand: "rfu",
      tripDate: "2026-03-20",
    };
    expect(quote(input)).toEqual(quote(input));
  });

  test("input validation — throws on missing cost", () => {
    expect(() => quote({ subBrand: "rfu", tripDate: "2026-01-01" })).toThrow(/cost row required/);
  });

  test("input validation — throws on missing subBrand", () => {
    expect(() => quote({ cost: HOTEL_COST, tripDate: "2026-01-01" })).toThrow(/subBrand required/);
  });
});
