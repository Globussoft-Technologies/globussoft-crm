// Unit tests for backend/middleware/travelGuards.js
//
// Pins the helpers that all travel routes share (extracted from the
// 4-file duplication that landed across Days 1-7). The middleware itself
// (requireTravelTenant) is integration-tested via the per-route gate
// specs — those exercise the 401/404/403/500 paths against a real
// Prisma + Express stack. This file covers:
//   - canAccessSubBrand: allowed=null → true, set membership semantics
//   - assertValidSubBrand: rejects out-of-enum, throws with status+code
//   - narrowWhereBySubBrand: query-narrowing semantics
//   - requireTravelTenant: 401 NO_TENANT / 404 TENANT_NOT_FOUND /
//     403 WRONG_VERTICAL / 200 happy path / 500 VERTICAL_GUARD_ERROR
//   - getSubBrandAccessSet: missing-user → empty Set, ADMIN → null,
//     null subBrandAccess → null, valid JSON → filtered Set,
//     malformed (catch branch) JSON → empty Set, empty array `"[]"` →
//     empty Set (deny-all, per #976), non-array JSON → null,
//     all-invalid-sub-brand array → empty Set (after VALID filter)
//   - assertCompletedDiagnostic: count=0 throws DIAGNOSTIC_REQUIRED,
//     count>=1 passes
//
// MOCK STRATEGY (extended 2026-05-25 — wave Travel-Security/Guard backfill):
//   Same singleton-patch pattern used by test/cron/slaBreachEngine.test.js
//   and test/lib/eventBus.test.js — `vitest.config.js` inlines
//   `backend/middleware/`, so monkey-patching prisma model methods on the
//   imported singleton propagates to the SUT's view of the module.

import { describe, test, expect, vi, beforeEach } from "vitest";
import prisma from "../../lib/prisma.js";

const {
  VALID_SUB_BRANDS,
  canAccessSubBrand,
  assertValidSubBrand,
  narrowWhereBySubBrand,
  requireTravelTenant,
  getSubBrandAccessSet,
  assertCompletedDiagnostic,
} = await import("../../middleware/travelGuards.js");

function makeReqRes({ user } = {}) {
  const req = { user };
  let statusCode = 200;
  const res = {
    status: vi.fn(function (c) {
      statusCode = c;
      return this;
    }),
    json: vi.fn(function (body) {
      this.body = body;
      return this;
    }),
    get statusCode() {
      return statusCode;
    },
  };
  const next = vi.fn();
  return { req, res, next };
}

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

describe("travelGuards — requireTravelTenant", () => {
  beforeEach(() => {
    prisma.tenant.findUnique = vi.fn();
  });

  test("401 NO_TENANT when req.user is undefined", async () => {
    const { req, res, next } = makeReqRes({ user: undefined });
    await requireTravelTenant(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.body).toEqual({ error: "Unauthenticated", code: "NO_TENANT" });
    expect(next).not.toHaveBeenCalled();
  });

  test("401 NO_TENANT when req.user.tenantId is missing", async () => {
    const { req, res, next } = makeReqRes({ user: { userId: 1 } });
    await requireTravelTenant(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.body).toEqual({ error: "Unauthenticated", code: "NO_TENANT" });
    expect(next).not.toHaveBeenCalled();
    // prisma should not be queried when tenantId is absent
    expect(prisma.tenant.findUnique).not.toHaveBeenCalled();
  });

  test("404 TENANT_NOT_FOUND when prisma returns null", async () => {
    prisma.tenant.findUnique.mockResolvedValue(null);
    const { req, res, next } = makeReqRes({ user: { userId: 1, tenantId: 99 } });
    await requireTravelTenant(req, res, next);
    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.body).toEqual({ error: "Tenant not found", code: "TENANT_NOT_FOUND" });
    expect(next).not.toHaveBeenCalled();
  });

  test("403 WRONG_VERTICAL when tenant.vertical !== 'travel'", async () => {
    prisma.tenant.findUnique.mockResolvedValue({
      id: 2,
      vertical: "wellness",
      name: "Enhanced Wellness",
      slug: "enhanced-wellness",
    });
    const { req, res, next } = makeReqRes({ user: { userId: 1, tenantId: 2 } });
    await requireTravelTenant(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.body.code).toBe("WRONG_VERTICAL");
    expect(next).not.toHaveBeenCalled();
  });

  test("happy path: attaches req.travelTenant and calls next()", async () => {
    const travelRow = { id: 7, vertical: "travel", name: "TMC", slug: "tmc-demo" };
    prisma.tenant.findUnique.mockResolvedValue(travelRow);
    const { req, res, next } = makeReqRes({ user: { userId: 1, tenantId: 7 } });
    await requireTravelTenant(req, res, next);
    expect(req.travelTenant).toEqual(travelRow);
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  test("500 VERTICAL_GUARD_ERROR when prisma throws", async () => {
    prisma.tenant.findUnique.mockRejectedValue(new Error("connection refused"));
    const { req, res, next } = makeReqRes({ user: { userId: 1, tenantId: 7 } });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await requireTravelTenant(req, res, next);
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.body).toEqual({ error: "Vertical guard failure", code: "VERTICAL_GUARD_ERROR" });
    expect(next).not.toHaveBeenCalled();
    errSpy.mockRestore();
  });
});

describe("travelGuards — getSubBrandAccessSet", () => {
  beforeEach(() => {
    prisma.user.findUnique = vi.fn();
  });

  test("returns empty Set when user row missing (deny everything)", async () => {
    prisma.user.findUnique.mockResolvedValue(null);
    const result = await getSubBrandAccessSet(42);
    expect(result).toBeInstanceOf(Set);
    expect(result.size).toBe(0);
  });

  test("ADMIN role returns null (full access, ignores subBrandAccess column)", async () => {
    prisma.user.findUnique.mockResolvedValue({
      role: "ADMIN",
      subBrandAccess: JSON.stringify(["tmc"]), // would normally narrow, but ADMIN bypasses
    });
    const result = await getSubBrandAccessSet(1);
    expect(result).toBeNull();
  });

  test("null subBrandAccess column returns null (full access for non-admin)", async () => {
    prisma.user.findUnique.mockResolvedValue({ role: "USER", subBrandAccess: null });
    const result = await getSubBrandAccessSet(3);
    expect(result).toBeNull();
  });

  test("valid JSON array filters to recognised sub-brands only", async () => {
    prisma.user.findUnique.mockResolvedValue({
      role: "USER",
      subBrandAccess: JSON.stringify(["tmc", "rfu", "bogus-brand", "travelstall"]),
    });
    const result = await getSubBrandAccessSet(4);
    expect(result).toBeInstanceOf(Set);
    expect([...result].sort()).toEqual(["rfu", "tmc", "travelstall"]);
    expect(result.has("bogus-brand")).toBe(false);
  });

  test("malformed JSON returns empty Set (defensive — treat as deny)", async () => {
    prisma.user.findUnique.mockResolvedValue({
      role: "USER",
      subBrandAccess: "{not-valid-json",
    });
    const result = await getSubBrandAccessSet(5);
    expect(result).toBeInstanceOf(Set);
    expect(result.size).toBe(0);
  });

  test("empty JSON array '[]' returns empty Set (#976: deny-all, NOT full access)", async () => {
    // Prior behavior (pre-#976): arr.length === 0 → null (full access).
    // Cause: the not-yet-onboarded MANAGER case (operator created with no
    // sub-brand grants yet) silently received tenant-wide access — the
    // per-route "empty access set → all-zeros rollup" branch was
    // unreachable from a clean state. Fixed in travelGuards.js by
    // returning new Set() instead of null on empty arrays.
    prisma.user.findUnique.mockResolvedValue({
      role: "USER",
      subBrandAccess: JSON.stringify([]),
    });
    const result = await getSubBrandAccessSet(6);
    expect(result).toBeInstanceOf(Set);
    expect(result.size).toBe(0);
  });

  test("non-array JSON returns null (defensive — falls through 'not Array' branch, preserves back-compat)", async () => {
    // Distinct from the empty-array case above: non-array JSON (an
    // object, a number, a string) is a malformed-but-typed shape — we
    // can't tell whether the operator intended deny-all or just typo'd
    // a non-array. Defaulting to null preserves backward-compat with
    // any historical bad rows.
    prisma.user.findUnique.mockResolvedValue({
      role: "USER",
      subBrandAccess: JSON.stringify({ tmc: true }),
    });
    const result = await getSubBrandAccessSet(7);
    expect(result).toBeNull();
  });

  test("array of all-invalid sub-brands returns empty Set (post-VALID_SUB_BRANDS filter)", async () => {
    // Distinct from the empty-array case: an array with entries that all
    // fail the VALID_SUB_BRANDS filter (e.g. `["bogus", "garbage"]`)
    // survives JSON.parse + the Array check, but filters down to a
    // Set of size 0. This path was the ONLY way to reach the empty-Set
    // branch from a non-malformed input pre-#976 — now joined by `"[]"`.
    prisma.user.findUnique.mockResolvedValue({
      role: "USER",
      subBrandAccess: JSON.stringify(["bogus", "garbage", "not-a-brand"]),
    });
    const result = await getSubBrandAccessSet(8);
    expect(result).toBeInstanceOf(Set);
    expect(result.size).toBe(0);
  });

  test("null subBrandAccess remains null (no regression — full access for unset operators)", async () => {
    // #976 fix carefully distinguishes:
    //   - column is NULL / missing → null (full access, unset = unrestricted)
    //   - column is "[]" (declared empty) → new Set() (deny-all)
    // This case pins the unset path stays null even after the fix.
    prisma.user.findUnique.mockResolvedValue({ role: "USER", subBrandAccess: null });
    const result = await getSubBrandAccessSet(9);
    expect(result).toBeNull();
  });
});

describe("travelGuards — assertCompletedDiagnostic", () => {
  test("throws 403 DIAGNOSTIC_REQUIRED when count is 0", async () => {
    const fakePrisma = { travelDiagnostic: { count: vi.fn().mockResolvedValue(0) } };
    let caught = null;
    try {
      await assertCompletedDiagnostic(fakePrisma, 5, 100, "tmc");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught.status).toBe(403);
    expect(caught.code).toBe("DIAGNOSTIC_REQUIRED");
    expect(caught.message).toContain("no completed diagnostic");
    expect(fakePrisma.travelDiagnostic.count).toHaveBeenCalledWith({
      where: { tenantId: 5, contactId: 100, subBrand: "tmc" },
    });
  });

  test("passes silently when count >= 1 (any diagnostic row counts)", async () => {
    const fakePrisma = { travelDiagnostic: { count: vi.fn().mockResolvedValue(1) } };
    await expect(
      assertCompletedDiagnostic(fakePrisma, 5, 100, "rfu"),
    ).resolves.toBeUndefined();
  });

  test("passes when count > 1 (multiple diagnostic rows — most-recent semantics)", async () => {
    const fakePrisma = { travelDiagnostic: { count: vi.fn().mockResolvedValue(4) } };
    await expect(
      assertCompletedDiagnostic(fakePrisma, 5, 100, "visasure"),
    ).resolves.toBeUndefined();
  });
});
