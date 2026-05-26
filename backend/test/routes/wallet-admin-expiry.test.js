// @ts-check
/**
 * Unit tests for backend/routes/wallet_admin.js — D16 Wallet Top-up Arc 1
 * polish slice (admin manual trigger for walletExpiryEngine).
 *
 * What this file pins
 * ───────────────────
 *   1. Happy path — ADMIN + confirmDestructive:true → 200 with envelope
 *      { success, tenantId, scanned, expired, errors[] }; engine called
 *      with the requesting tenantId (NOT a body-supplied one — proves
 *      stripDangerous + tenant-isolation contract).
 *   2. Envelope echoes engine's tenantId from req.user (not body).
 *   3. Missing confirmDestructive → 400 CONFIRMATION_REQUIRED; engine
 *      NEVER called (zero DB mutation surface — pin via spy).
 *   4. confirmDestructive=false (explicit) → 400 (the "true" must be
 *      strict-equality, not just truthy).
 *   5. confirmDestructive='true' string → 400 (strict true required).
 *   6. USER role → 403 (verifyRole guard).
 *   7. MANAGER role → 403 (only ADMIN gets the trigger).
 *   8. Unauthenticated (no Authorization header) → 401.
 *   9. Engine returns errors[] → endpoint passes through verbatim.
 *  10. Engine throws → 500 + WALLET_EXPIRY_RUN_FAILED.
 *  11. Audit emission — WALLET_EXPIRY_MANUAL_TRIGGER row written on
 *      happy path with via:'manual' + counters.
 *  12. NO audit emitted when confirmDestructive guard rejects.
 *
 * Pattern mirrors backend/test/routes/adsgpt.test.js — patch the CJS
 * module's exports with vi.fn() BEFORE requiring the router. The route
 * captures `walletExpiryEngine` + `writeAudit` at module load via
 * `require(...)`, so mutating the require-cache module's exports BEFORE
 * the router requires it makes the spies visible inside the route's
 * closure. This exercises actual middleware/auth (verifyToken +
 * verifyRole) end-to-end — more faithful to the production wire than
 * mocking the middleware itself.
 *
 * The walletExpiryEngine sweep math has its own 19-case suite at
 * backend/test/cron/walletExpiryEngine.test.js; this file pins the
 * ROUTE contract (auth + body-guard + envelope passthrough + audit).
 */

import { describe, test, expect, beforeEach, vi } from "vitest";
import prisma from "../../lib/prisma.js";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import { createRequire } from "node:module";

const requireCJS = createRequire(import.meta.url);
const JWT_SECRET =
  process.env.JWT_SECRET || "enterprise_super_secret_key_2026";

// Patch the CJS module exports BEFORE the router requires them. Mutating
// the require-cache module's exports makes the spies visible inside the
// router's closure (which captured these references at its own load).
const walletExpiryEngine = requireCJS("../../cron/walletExpiryEngine");
walletExpiryEngine.runForTenant = vi.fn();

const auditLib = requireCJS("../../lib/audit");
auditLib.writeAudit = vi.fn().mockResolvedValue({ id: 999 });

// Prisma stubs for verifyToken's revokedToken lookup.
prisma.revokedToken = prisma.revokedToken || {};
prisma.revokedToken.findUnique = vi.fn().mockResolvedValue(null);
prisma.auditLog = { create: vi.fn().mockResolvedValue({ id: 1 }) };

// Now require the router — it picks up the patched engine + audit.
const adminRouter = requireCJS("../../routes/wallet_admin");

function tokenFor(role = "ADMIN", { userId = 7, tenantId = 1 } = {}) {
  return jwt.sign(
    { userId, tenantId, role, email: `${role.toLowerCase()}@test.local` },
    JWT_SECRET,
    { expiresIn: "1h" },
  );
}

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/wallet/admin", adminRouter);
  return app;
}

beforeEach(() => {
  walletExpiryEngine.runForTenant.mockReset();
  auditLib.writeAudit.mockReset();
  auditLib.writeAudit.mockResolvedValue({ id: 999 });
  prisma.revokedToken.findUnique.mockResolvedValue(null);
  prisma.auditLog.create.mockReset();
  prisma.auditLog.create.mockResolvedValue({ id: 1 });
});

// ─── 1 + 2. Happy path ───────────────────────────────────────────────────
describe("POST /api/wallet/admin/run-expiry — happy path", () => {
  test("ADMIN + confirmDestructive:true → 200 with envelope", async () => {
    walletExpiryEngine.runForTenant.mockResolvedValue({
      tenantId: 1,
      scanned: 5,
      expired: 3,
      errors: [],
    });

    const res = await request(makeApp())
      .post("/api/wallet/admin/run-expiry")
      .set("Authorization", `Bearer ${tokenFor("ADMIN", { tenantId: 1 })}`)
      .send({ confirmDestructive: true });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      success: true,
      tenantId: 1,
      scanned: 5,
      expired: 3,
      errors: [],
    });
    // Engine called with req.user.tenantId (NOT a body field) — the
    // tenant-isolation contract.
    expect(walletExpiryEngine.runForTenant).toHaveBeenCalledTimes(1);
    expect(walletExpiryEngine.runForTenant).toHaveBeenCalledWith(1);
  });

  test("envelope echoes engine's tenantId from req.user (not body)", async () => {
    walletExpiryEngine.runForTenant.mockResolvedValue({
      tenantId: 42,
      scanned: 0,
      expired: 0,
      errors: [],
    });

    const res = await request(makeApp())
      .post("/api/wallet/admin/run-expiry")
      .set("Authorization", `Bearer ${tokenFor("ADMIN", { tenantId: 42 })}`)
      // Even if a body tenantId is smuggled, the engine call MUST reflect
      // req.user.tenantId. stripDangerous would strip it in prod anyway;
      // this pin confirms the route doesn't read body.tenantId directly.
      .send({ confirmDestructive: true, tenantId: 999 });

    expect(res.status).toBe(200);
    expect(res.body.tenantId).toBe(42);
    expect(walletExpiryEngine.runForTenant).toHaveBeenCalledWith(42);
  });
});

// ─── 3 + 4 + 5. confirmDestructive guard ─────────────────────────────────
describe("POST /api/wallet/admin/run-expiry — confirmDestructive guard", () => {
  test("missing confirmDestructive → 400 CONFIRMATION_REQUIRED; engine NOT called", async () => {
    const res = await request(makeApp())
      .post("/api/wallet/admin/run-expiry")
      .set("Authorization", `Bearer ${tokenFor("ADMIN")}`)
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.code).toBe("CONFIRMATION_REQUIRED");
    expect(res.body.error).toMatch(/confirmDestructive/i);
    expect(walletExpiryEngine.runForTenant).not.toHaveBeenCalled();
  });

  test("confirmDestructive=false → 400 (strict equality, not truthy)", async () => {
    const res = await request(makeApp())
      .post("/api/wallet/admin/run-expiry")
      .set("Authorization", `Bearer ${tokenFor("ADMIN")}`)
      .send({ confirmDestructive: false });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("CONFIRMATION_REQUIRED");
    expect(walletExpiryEngine.runForTenant).not.toHaveBeenCalled();
  });

  test("confirmDestructive='true' string → 400 (strict true required)", async () => {
    const res = await request(makeApp())
      .post("/api/wallet/admin/run-expiry")
      .set("Authorization", `Bearer ${tokenFor("ADMIN")}`)
      .send({ confirmDestructive: "true" });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("CONFIRMATION_REQUIRED");
    expect(walletExpiryEngine.runForTenant).not.toHaveBeenCalled();
  });
});

// ─── 6 + 7 + 8. RBAC + auth ──────────────────────────────────────────────
describe("POST /api/wallet/admin/run-expiry — RBAC", () => {
  test("USER role → 403", async () => {
    const res = await request(makeApp())
      .post("/api/wallet/admin/run-expiry")
      .set("Authorization", `Bearer ${tokenFor("USER")}`)
      .send({ confirmDestructive: true });

    expect(res.status).toBe(403);
    expect(walletExpiryEngine.runForTenant).not.toHaveBeenCalled();
  });

  test("MANAGER role → 403 (only ADMIN gets the trigger)", async () => {
    const res = await request(makeApp())
      .post("/api/wallet/admin/run-expiry")
      .set("Authorization", `Bearer ${tokenFor("MANAGER")}`)
      .send({ confirmDestructive: true });

    expect(res.status).toBe(403);
    expect(walletExpiryEngine.runForTenant).not.toHaveBeenCalled();
  });

  test("unauthenticated (no Authorization header) → 401", async () => {
    const res = await request(makeApp())
      .post("/api/wallet/admin/run-expiry")
      .send({ confirmDestructive: true });

    expect(res.status).toBe(401);
    expect(walletExpiryEngine.runForTenant).not.toHaveBeenCalled();
  });
});

// ─── 9. Engine error passthrough ─────────────────────────────────────────
describe("POST /api/wallet/admin/run-expiry — engine error passthrough", () => {
  test("engine returns errors[] → endpoint passes through verbatim", async () => {
    walletExpiryEngine.runForTenant.mockResolvedValue({
      tenantId: 1,
      scanned: 4,
      expired: 2,
      errors: [
        { batchId: 11, error: "wallet vanished" },
        { batchId: 13, error: "concurrent update" },
      ],
    });

    const res = await request(makeApp())
      .post("/api/wallet/admin/run-expiry")
      .set("Authorization", `Bearer ${tokenFor("ADMIN")}`)
      .send({ confirmDestructive: true });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.scanned).toBe(4);
    expect(res.body.expired).toBe(2);
    expect(res.body.errors).toHaveLength(2);
    expect(res.body.errors[0].batchId).toBe(11);
    expect(res.body.errors[1].error).toBe("concurrent update");
  });
});

// ─── 10. Engine top-level throw ──────────────────────────────────────────
describe("POST /api/wallet/admin/run-expiry — engine throws", () => {
  test("engine rejection → 500 WALLET_EXPIRY_RUN_FAILED", async () => {
    walletExpiryEngine.runForTenant.mockRejectedValue(
      new Error("database connection lost"),
    );

    const res = await request(makeApp())
      .post("/api/wallet/admin/run-expiry")
      .set("Authorization", `Bearer ${tokenFor("ADMIN", { tenantId: 7 })}`)
      .send({ confirmDestructive: true });

    expect(res.status).toBe(500);
    expect(res.body.success).toBe(false);
    expect(res.body.tenantId).toBe(7);
    expect(res.body.code).toBe("WALLET_EXPIRY_RUN_FAILED");
    expect(res.body.error).toMatch(/database connection lost/);
  });
});

// ─── 11 + 12. Audit emission ─────────────────────────────────────────────
describe("POST /api/wallet/admin/run-expiry — audit", () => {
  test("emits WALLET_EXPIRY_MANUAL_TRIGGER audit on success", async () => {
    walletExpiryEngine.runForTenant.mockResolvedValue({
      tenantId: 1,
      scanned: 6,
      expired: 4,
      errors: [{ batchId: 99, error: "x" }],
    });

    await request(makeApp())
      .post("/api/wallet/admin/run-expiry")
      .set(
        "Authorization",
        `Bearer ${tokenFor("ADMIN", { userId: 17, tenantId: 1 })}`,
      )
      .send({ confirmDestructive: true });

    // Flush microtasks so the fire-and-forget writeAudit settles.
    await new Promise((r) => setImmediate(r));

    expect(auditLib.writeAudit).toHaveBeenCalledTimes(1);
    const [entity, action, entityId, userId, tenantId, details] =
      auditLib.writeAudit.mock.calls[0];
    expect(entity).toBe("Wallet");
    expect(action).toBe("WALLET_EXPIRY_MANUAL_TRIGGER");
    expect(entityId).toBeNull();
    expect(userId).toBe(17);
    expect(tenantId).toBe(1);
    expect(details).toEqual({
      via: "manual",
      scanned: 6,
      expired: 4,
      errorCount: 1,
    });
  });

  test("does NOT emit audit when confirmDestructive guard rejects", async () => {
    await request(makeApp())
      .post("/api/wallet/admin/run-expiry")
      .set("Authorization", `Bearer ${tokenFor("ADMIN")}`)
      .send({});

    await new Promise((r) => setImmediate(r));
    expect(auditLib.writeAudit).not.toHaveBeenCalled();
  });
});
