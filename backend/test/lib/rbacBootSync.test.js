import { describe, expect, it, vi, afterEach } from "vitest";
import { runRbacBootSync } from "../../lib/rbacBootSync.js";

describe("runRbacBootSync", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("waits for RBAC reconciliation and reports the completed stats", async () => {
    const sync = vi.fn().mockResolvedValue({
      rolesCreated: 1,
      permsCreated: 4,
      assignmentsCreated: 1,
      usersSkipped: 0,
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    await expect(runRbacBootSync({ sync })).resolves.toMatchObject({
      rolesCreated: 1,
      permsCreated: 4,
      assignmentsCreated: 1,
    });
    expect(sync).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("[rbac-boot] backfilled"),
    );
  });

  it("keeps boot fail-open when the database reconciliation fails", async () => {
    const error = new Error("database unavailable");
    const sync = vi.fn().mockRejectedValue(error);
    const logError = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(runRbacBootSync({ sync })).resolves.toBeNull();
    expect(logError).toHaveBeenCalledWith(
      "[rbac-boot] non-fatal error:",
      "database unavailable",
    );
  });
});
