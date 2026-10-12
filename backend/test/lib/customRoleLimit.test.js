import { describe, expect, test, vi } from "vitest";
import { createRequire } from "node:module";

const requireCJS = createRequire(import.meta.url);
const {
  normalizeCustomRoleLimit,
  getCustomRoleSummary,
  assertCustomRoleCreationAllowed,
} = requireCJS("../../lib/customRoleLimit.js");

describe("customRoleLimit", () => {
  test("normalizes integer limits and null as unlimited", () => {
    expect(normalizeCustomRoleLimit(null)).toBeNull();
    expect(normalizeCustomRoleLimit(0)).toBe(0);
    expect(normalizeCustomRoleLimit("5")).toBe(5);
    expect(() => normalizeCustomRoleLimit(-1)).toThrowError(/between 0 and/);
    expect(() => normalizeCustomRoleLimit(1.5)).toThrowError(/between 0 and/);
    expect(() => normalizeCustomRoleLimit(100001)).toThrowError(/between 0 and/);
  });

  test("summarizes usage, remaining capacity, and unlimited tenants", async () => {
    const db = {
      role: { count: vi.fn().mockResolvedValue(3) },
    };

    await expect(getCustomRoleSummary(db, 7, { id: 7, maxCustomRoles: 5 }))
      .resolves.toEqual({
        customRoleCount: 3,
        maxCustomRoles: 5,
        remainingCustomRoles: 2,
        roleLimitReached: false,
      });
    expect(db.role.count).toHaveBeenCalledWith({
      where: { tenantId: 7, isSystem: false, isActive: true },
    });

    db.role.count.mockResolvedValue(8);
    await expect(getCustomRoleSummary(db, 7, { id: 7, maxCustomRoles: null }))
      .resolves.toMatchObject({
        customRoleCount: 8,
        maxCustomRoles: null,
        remainingCustomRoles: null,
        roleLimitReached: false,
      });
  });

  test("locks the tenant row and blocks creation at the configured limit", async () => {
    const db = {
      $queryRaw: vi.fn().mockResolvedValue([{ id: 7, maxCustomRoles: 2 }]),
      role: { count: vi.fn().mockResolvedValue(2) },
    };

    await expect(assertCustomRoleCreationAllowed(db, 7))
      .rejects.toMatchObject({
        code: "ROLE_LIMIT_REACHED",
        customRoleCount: 2,
        maxCustomRoles: 2,
      });
    expect(db.$queryRaw).toHaveBeenCalledOnce();
  });

  test("allows creation when unlimited or below the limit", async () => {
    const db = {
      $queryRaw: vi.fn().mockResolvedValue([{ id: 7, maxCustomRoles: null }]),
      role: { count: vi.fn().mockResolvedValue(50) },
    };

    await expect(assertCustomRoleCreationAllowed(db, 7)).resolves.toEqual({
      customRoleCount: 50,
      maxCustomRoles: null,
    });
  });
});
