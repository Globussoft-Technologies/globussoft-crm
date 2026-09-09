import { beforeEach, describe, expect, test, vi } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import { createRequire } from "node:module";
import prisma from "../../lib/prisma.js";

const requireCJS = createRequire(import.meta.url);
const JWT_SECRET = process.env.JWT_SECRET || "enterprise_super_secret_key_2026";

prisma.tenant = prisma.tenant || {};
prisma.tenant.findUnique = vi.fn();
prisma.user = prisma.user || {};
prisma.user.findUnique = vi.fn();
prisma.revokedToken = prisma.revokedToken || {};
prisma.revokedToken.findUnique = vi.fn();
prisma.integration = { findUnique: vi.fn(), upsert: vi.fn() };
prisma.auditLog = { create: vi.fn(), findFirst: vi.fn() };
prisma.travelTallySyncLog = { findMany: vi.fn(), create: vi.fn() };

const connectorRouter = requireCJS("../../routes/travel_tally_connector");

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/travel/tally/connector", connectorRouter);
  return app;
}

function auth() {
  const token = jwt.sign({ userId: 7, tenantId: 1, role: "ADMIN", email: "admin@test.local" }, JWT_SECRET, { expiresIn: "1h" });
  return { Authorization: `Bearer ${token}` };
}

beforeEach(() => {
  prisma.tenant.findUnique.mockReset().mockResolvedValue({ id: 1, vertical: "travel", name: "Travel Test", slug: "travel-test" });
  prisma.user.findUnique.mockReset().mockResolvedValue({ id: 7, role: "ADMIN", deactivatedAt: null, sessionVersion: 0 });
  prisma.revokedToken.findUnique.mockReset().mockResolvedValue(null);
  prisma.integration.findUnique.mockReset().mockResolvedValue(null);
  prisma.integration.upsert.mockReset().mockResolvedValue({ id: 10 });
  prisma.auditLog.create.mockReset().mockResolvedValue({ id: 1 });
  prisma.auditLog.findFirst.mockReset().mockResolvedValue(null);
  prisma.travelTallySyncLog.findMany.mockReset().mockResolvedValue([]);
  prisma.travelTallySyncLog.create.mockReset().mockResolvedValue({ id: 1 });
});

describe("travel Tally connector routes", () => {
  test("requires authentication and the travel vertical", async () => {
    expect((await request(makeApp()).get("/api/travel/tally/connector/status")).status).toBeGreaterThanOrEqual(401);
    prisma.tenant.findUnique.mockResolvedValue({ id: 1, vertical: "generic", name: "Generic", slug: "generic" });
    const wrongVertical = await request(makeApp()).get("/api/travel/tally/connector/status").set(auth());
    expect(wrongVertical.status).toBe(403);
    expect(wrongVertical.body.code).toBe("WRONG_VERTICAL");
  });

  test("returns safe status without exposing the stored token hash", async () => {
    prisma.integration.findUnique.mockResolvedValue({
      isActive: true,
      settings: JSON.stringify({ connectorId: "tally_public_id", createdAt: "2026-09-09T00:00:00.000Z" }),
    });
    const response = await request(makeApp()).get("/api/travel/tally/connector/status").set(auth());
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ configured: true, online: false, credentials: { connectorId: "tally_public_id" } });
    expect(JSON.stringify(response.body)).not.toContain("tokenHash");
    expect(response.body).not.toHaveProperty("token");
  });

  test("generates a one-time token and stores only its hash", async () => {
    const response = await request(makeApp()).post("/api/travel/tally/connector/credentials").set(auth()).send({});
    expect(response.status).toBe(201);
    expect(response.body.token).toMatch(/^[a-f0-9]{64}$/);
    expect(response.body.customerId).toBe(1);
    const args = prisma.integration.upsert.mock.calls[0][0];
    expect(args.create.token).toMatch(/^[a-f0-9]{64}$/);
    expect(args.create.token).not.toBe(response.body.token);
    expect(args.create.settings).not.toContain(response.body.token);
  });

  test("rejects malformed XML and reports an offline connector safely", async () => {
    const malformed = await request(makeApp()).post("/api/travel/tally/connector/push").set(auth()).send({ vouchersXml: "<bad />" });
    expect(malformed.status).toBe(400);
    expect(malformed.body.code).toBe("INVALID_TALLY_XML");

    const offline = await request(makeApp()).post("/api/travel/tally/connector/push").set(auth()).send({ vouchersXml: "<ENVELOPE></ENVELOPE>" });
    expect(offline.status).toBe(503);
    expect(offline.body.code).toBe("TALLY_CONNECTOR_OFFLINE");
  });
});
