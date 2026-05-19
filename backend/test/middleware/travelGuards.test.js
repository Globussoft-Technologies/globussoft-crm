// Unit tests for backend/middleware/travelGuards.js
//
// Pins the helpers that all travel routes share (extracted from the
// 4-file duplication that landed across Days 1-7). The middleware itself
// (requireTravelTenant) is integration-tested via the per-route gate
// specs — those exercise the 401/404/403/500 paths against a real
// Prisma + Express stack. This file only covers the pure helpers
// (no I/O):
//   - canAccessSubBrand: allowed=null → true, set membership semantics
//   - assertValidSubBrand: rejects out-of-enum, throws with status+code
//   - narrowWhereBySubBrand: query-narrowing semantics

import { describe, test, expect } from "vitest";

const {
  VALID_SUB_BRANDS,
  canAccessSubBrand,
  assertValidSubBrand,
  narrowWhereBySubBrand,
} = await import("../../middleware/travelGuards.js");

describe("travelGuards — VALID_SUB_BRANDS", () => {
  test("frozen, contains the 4 sub-brands", () => {
    expect([...VALID_SUB_BRANDS]).toEqual(["tmc", "rfu", "travelstall", "visasure"]);
    expect(Object.isFrozen(VALID_SUB_BRANDS)).toBe(true);
  });
});

describe("travelGuards — canAccessSubBrand", () => {
  test("null (full access) always returns true", () => {
    expect(canAccessSubBrand(null, "tmc")).toBe(true);
    expect(canAccessSubBrand(null, "rfu")).toBe(true);
    expect(canAccessSubBrand(null, "anything")).toBe(true);
  });

  test("Set with member returns true", () => {
    expect(canAccessSubBrand(new Set(["tmc", "rfu"]), "tmc")).toBe(true);
    expect(canAccessSubBrand(new Set(["tmc", "rfu"]), "rfu")).toBe(true);
  });

  test("Set without member returns false", () => {
    expect(canAccessSubBrand(new Set(["tmc"]), "rfu")).toBe(false);
    expect(canAccessSubBrand(new Set(["tmc"]), "travelstall")).toBe(false);
  });

  test("empty Set returns false (deny everything)", () => {
    expect(canAccessSubBrand(new Set(), "tmc")).toBe(false);
  });

  test("non-Set/non-null inputs return false (defensive)", () => {
    expect(canAccessSubBrand(undefined, "tmc")).toBe(false);
    expect(canAccessSubBrand(["tmc"], "tmc")).toBe(false); // array isn't Set
    expect(canAccessSubBrand("tmc", "tmc")).toBe(false);
  });
});

describe("travelGuards — assertValidSubBrand", () => {
  test("accepts all 4 canonical sub-brands without throwing", () => {
    for (const s of ["tmc", "rfu", "travelstall", "visasure"]) {
      expect(() => assertValidSubBrand(s)).not.toThrow();
    }
  });

  test("throws on unknown value with status=400 + code=INVALID_SUB_BRAND", () => {
    try {
      assertValidSubBrand("made-up");
      throw new Error("should have thrown");
    } catch (e) {
      expect(e.status).toBe(400);
      expect(e.code).toBe("INVALID_SUB_BRAND");
      expect(e.message).toContain("subBrand must be one of");
    }
  });

  test("throws on case-mismatched value (canonical is lowercase)", () => {
    expect(() => assertValidSubBrand("TMC")).toThrow(/subBrand must be/);
  });

  test("throws on empty string", () => {
    expect(() => assertValidSubBrand("")).toThrow(/subBrand must be/);
  });
});

describe("travelGuards — narrowWhereBySubBrand", () => {
  test("allowed=null leaves where untouched", () => {
    const where = { tenantId: 5 };
    const result = narrowWhereBySubBrand(where, null);
    expect(result).toBe(where); // returns same ref
    expect(result.subBrand).toBeUndefined();
  });

  test("allowed=null preserves an existing subBrand filter", () => {
    const where = { tenantId: 5, subBrand: "tmc" };
    narrowWhereBySubBrand(where, null);
    expect(where.subBrand).toBe("tmc");
  });

  test("Set-based access narrows where.subBrand to { in: [...allowed] } when unset", () => {
    const where = { tenantId: 5 };
    narrowWhereBySubBrand(where, new Set(["tmc", "rfu"]));
    expect(where.subBrand).toEqual({ in: expect.any(Array) });
    expect(where.subBrand.in).toContain("tmc");
    expect(where.subBrand.in).toContain("rfu");
    expect(where.subBrand.in).not.toContain("travelstall");
  });

  test("Set-based access keeps where.subBrand when caller-requested + allowed", () => {
    const where = { tenantId: 5, subBrand: "tmc" };
    narrowWhereBySubBrand(where, new Set(["tmc", "rfu"]));
    expect(where.subBrand).toBe("tmc");
  });

  test("Set-based access substitutes \"__none__\" when caller-requested but NOT allowed", () => {
    const where = { tenantId: 5, subBrand: "travelstall" };
    narrowWhereBySubBrand(where, new Set(["tmc", "rfu"]));
    expect(where.subBrand).toBe("__none__");
    // Why "__none__" not 403: matches the existing CRM convention of
    // silent empty result-sets when a caller can't see something.
  });
});
