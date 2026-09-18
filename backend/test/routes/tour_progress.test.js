import { beforeEach, describe, expect, test, vi } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import { createRequire } from "node:module";
import prisma from "../../lib/prisma.js";

prisma.user = prisma.user || {};
prisma.user.findFirst = vi.fn();
prisma.userTourProgress = prisma.userTourProgress || {};
prisma.userTourProgress.findUnique = vi.fn();
prisma.userTourProgress.upsert = vi.fn();
prisma.tenant = prisma.tenant || {};
prisma.tenant.updateMany = vi.fn();
prisma.revokedToken = prisma.revokedToken || {};
prisma.revokedToken.findUnique = vi.fn().mockResolvedValue(null);

const requireCJS = createRequire(import.meta.url);
const router = requireCJS("../../routes/tour_progress");
const JWT_SECRET = process.env.JWT_SECRET || "enterprise_super_secret_key_2026";

function app() {
  const instance = express();
  instance.use(express.json());
  instance.use("/api/tours", router);
  return instance;
}

function token(userId = 7, tenantId = 3, role = "USER") {
  return jwt.sign({ userId, tenantId, role, email: "tour@test.local" }, JWT_SECRET, { expiresIn: "1h" });
}

function row(overrides = {}) {
  return {
    id: 1,
    tenantId: 3,
    userId: 7,
    preferencesJson: JSON.stringify({ enabled: true, autoStart: false, updatedAt: "2026-09-12T10:00:00.000Z" }),
    progressJson: JSON.stringify({ "dashboard:1": { status: "COMPLETED", currentStep: 2, updatedAt: "2026-09-12T10:01:00.000Z" } }),
    progressResetAt: null,
    updatedAt: new Date("2026-09-12T10:02:00.000Z"),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  prisma.revokedToken.findUnique.mockResolvedValue(null);
  prisma.user.findFirst.mockResolvedValue({ id: 7, tenant: { productToursEnabled: true } });
  prisma.tenant.updateMany.mockResolvedValue({ count: 1 });
  prisma.userTourProgress.findUnique.mockResolvedValue(null);
  prisma.userTourProgress.upsert.mockImplementation(({ create }) => Promise.resolve(row({
    preferencesJson: create.preferencesJson,
    progressJson: create.progressJson,
    progressResetAt: create.progressResetAt,
  })));
});

describe("tour progress routes", () => {
  test("require authentication", async () => {
    expect((await request(app()).get("/api/tours/state")).status).toBe(401);
    expect(prisma.userTourProgress.findUnique).not.toHaveBeenCalled();
  });

  test("GET returns defaults and scopes both the user and progress lookup", async () => {
    const response = await request(app()).get("/api/tours/state").set("Authorization", `Bearer ${token()}`);
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ preferences: { enabled: true, autoStart: true }, progress: {}, progressResetAt: null });
    expect(prisma.user.findFirst).toHaveBeenCalledWith({ where: { id: 7, tenantId: 3 }, select: { id: true, tenant: { select: { productToursEnabled: true } } } });
    expect(prisma.userTourProgress.findUnique).toHaveBeenCalledWith({ where: { tenantId_userId: { tenantId: 3, userId: 7 } } });
  });

  test("returns 404 when the JWT user does not belong to its tenant", async () => {
    prisma.user.findFirst.mockResolvedValue(null);
    const response = await request(app()).put("/api/tours/state").set("Authorization", `Bearer ${token(99, 8)}`).send({
      preferences: { enabled: true, autoStart: true }, progress: {}, progressResetAt: null,
    });
    expect(response.status).toBe(404);
    expect(response.body.code).toBe("USER_NOT_FOUND");
    expect(prisma.userTourProgress.upsert).not.toHaveBeenCalled();
  });

  test("PUT state validates and upserts the tenant/user-owned state", async () => {
    const payload = {
      preferences: { enabled: false, autoStart: true, updatedAt: "2026-09-12T11:00:00.000Z" },
      progress: { "contacts:2": { status: "IN_PROGRESS", currentStep: 1, updatedAt: "2026-09-12T11:01:00.000Z" } },
      progressResetAt: null,
    };
    const response = await request(app()).put("/api/tours/state").set("Authorization", `Bearer ${token()}`).send(payload);
    expect(response.status).toBe(200);
    const args = prisma.userTourProgress.upsert.mock.calls[0][0];
    expect(args.where).toEqual({ tenantId_userId: { tenantId: 3, userId: 7 } });
    expect(args.create).toMatchObject({ tenantId: 3, userId: 7 });
    expect(JSON.parse(args.create.preferencesJson)).toMatchObject({ enabled: false, autoStart: true });
    expect(JSON.parse(args.create.progressJson)["contacts:2"].status).toBe("IN_PROGRESS");
  });

  test("rejects malformed statuses, keys, steps, and preference values", async () => {
    const badPayloads = [
      { preferences: { enabled: "yes", autoStart: true }, progress: {} },
      { preferences: { enabled: true, autoStart: true }, progress: { "../bad": { status: "COMPLETED", currentStep: 0, updatedAt: new Date().toISOString() } } },
      { preferences: { enabled: true, autoStart: true }, progress: { "dashboard:1": { status: "UNKNOWN", currentStep: 0, updatedAt: new Date().toISOString() } } },
      { preferences: { enabled: true, autoStart: true }, progress: { "dashboard:1": { status: "IN_PROGRESS", currentStep: 999, updatedAt: new Date().toISOString() } } },
    ];
    for (const payload of badPayloads) {
      const response = await request(app()).put("/api/tours/state").set("Authorization", `Bearer ${token()}`).send(payload);
      expect(response.status).toBe(400);
      expect(response.body.code).toBe("INVALID_TOUR_STATE");
    }
  });

  test("full-state synchronization does not overwrite newer progress from another device", async () => {
    prisma.userTourProgress.findUnique.mockResolvedValue(row());
    prisma.userTourProgress.upsert.mockImplementation(({ update }) => Promise.resolve(row({
      preferencesJson: update.preferencesJson,
      progressJson: update.progressJson,
      progressResetAt: update.progressResetAt,
    })));
    const response = await request(app()).put("/api/tours/state").set("Authorization", `Bearer ${token()}`).send({
      preferences: { enabled: false, autoStart: true, updatedAt: "2026-09-12T09:00:00.000Z" },
      progress: {
        "dashboard:1": { status: "IN_PROGRESS", currentStep: 0, updatedAt: "2026-09-12T09:30:00.000Z" },
        "contacts:1": { status: "IN_PROGRESS", currentStep: 1, updatedAt: "2026-09-12T11:00:00.000Z" },
      },
      progressResetAt: null,
    });
    expect(response.status).toBe(200);
    expect(response.body.preferences).toMatchObject({ enabled: true, autoStart: false });
    expect(response.body.progress["dashboard:1"].status).toBe("COMPLETED");
    expect(response.body.progress["contacts:1"].status).toBe("IN_PROGRESS");
  });

  test("preference and single-progress endpoints preserve the other state", async () => {
    prisma.userTourProgress.findUnique.mockResolvedValue(row());
    prisma.userTourProgress.upsert.mockImplementation(({ update }) => Promise.resolve(row({
      preferencesJson: update.preferencesJson,
      progressJson: update.progressJson,
      progressResetAt: update.progressResetAt,
    })));
    const preferenceResponse = await request(app()).put("/api/tours/preferences").set("Authorization", `Bearer ${token()}`).send({ enabled: false });
    expect(preferenceResponse.status).toBe(200);
    expect(preferenceResponse.body.preferences).toMatchObject({ enabled: false, autoStart: false });
    expect(preferenceResponse.body.progress["dashboard:1"].status).toBe("COMPLETED");

    const progressResponse = await request(app()).put("/api/tours/progress/leads:1").set("Authorization", `Bearer ${token()}`).send({ status: "DISMISSED", currentStep: 2 });
    expect(progressResponse.status).toBe(200);
    expect(progressResponse.body.progress["leads:1"]).toMatchObject({ status: "DISMISSED", currentStep: 2 });
  });

  test("DELETE progress clears records and writes a reset marker", async () => {
    prisma.userTourProgress.findUnique.mockResolvedValue(row());
    const response = await request(app()).delete("/api/tours/progress").set("Authorization", `Bearer ${token()}`);
    expect(response.status).toBe(200);
    const args = prisma.userTourProgress.upsert.mock.calls[0][0];
    expect(JSON.parse(args.update.progressJson)).toEqual({});
    expect(args.update.progressResetAt).toBeInstanceOf(Date);
  });

  test("returns the organization setting and only lets administrators change it", async () => {
    prisma.user.findFirst.mockResolvedValue({ id: 7, tenant: { productToursEnabled: false } });
    const read = await request(app()).get("/api/tours/organization-preferences").set("Authorization", `Bearer ${token()}`);
    expect(read.status).toBe(200);
    expect(read.body).toEqual({ organizationEnabled: false });

    const denied = await request(app()).put("/api/tours/organization-preferences").set("Authorization", `Bearer ${token()}`).send({ organizationEnabled: true });
    expect(denied.status).toBe(403);
    expect(denied.body.code).toBe("RBAC_DENIED");
    expect(prisma.tenant.updateMany).not.toHaveBeenCalled();

    const allowed = await request(app()).put("/api/tours/organization-preferences").set("Authorization", `Bearer ${token(7, 3, "ADMIN")}`).send({ organizationEnabled: false });
    expect(allowed.status).toBe(200);
    expect(prisma.tenant.updateMany).toHaveBeenCalledWith({ where: { id: 3 }, data: { productToursEnabled: false } });
  });

  test("validates organization settings and scopes missing tenants", async () => {
    const invalid = await request(app()).put("/api/tours/organization-preferences").set("Authorization", `Bearer ${token(7, 3, "ADMIN")}`).send({ organizationEnabled: "yes" });
    expect(invalid.status).toBe(400);
    expect(invalid.body.code).toBe("INVALID_TOUR_ORGANIZATION_PREFERENCES");
    prisma.tenant.updateMany.mockResolvedValue({ count: 0 });
    const missing = await request(app()).put("/api/tours/organization-preferences").set("Authorization", `Bearer ${token(7, 3, "ADMIN")}`).send({ organizationEnabled: true });
    expect(missing.status).toBe(404);
    expect(missing.body.code).toBe("TENANT_NOT_FOUND");
  });
});
