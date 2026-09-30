import { afterAll, beforeEach, describe, expect, test, vi } from "vitest";
import prisma from "../../lib/prisma.js";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import { createRequire } from "node:module";

prisma.tenantSetting = {
  findUnique: vi.fn(),
  upsert: vi.fn(),
  deleteMany: vi.fn(),
};
prisma.auditLog = {
  ...(prisma.auditLog || {}),
  findFirst: vi.fn(),
  count: vi.fn(),
  create: vi.fn(),
};
prisma.revokedToken = prisma.revokedToken || {};
prisma.revokedToken.findUnique = vi.fn().mockResolvedValue(null);

const requireCJS = createRequire(import.meta.url);
const previousCredentialKey = process.env.TRAVEL_MEETING_CREDENTIAL_KEY;
process.env.TRAVEL_MEETING_CREDENTIAL_KEY = "d".repeat(64);
const router = requireCJS("../../routes/travel_email_provider");
const travelSendGrid = requireCJS("../../services/travelSendGrid");
const { decryptTravelMeetingCredential } = requireCJS("../../lib/travelMeetingCredentialEncryption");
const JWT_SECRET = process.env.JWT_SECRET || "enterprise_super_secret_key_2026";

afterAll(() => {
  if (previousCredentialKey === undefined) delete process.env.TRAVEL_MEETING_CREDENTIAL_KEY;
  else process.env.TRAVEL_MEETING_CREDENTIAL_KEY = previousCredentialKey;
});

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/travel/email-provider", router);
  return app;
}

function tokenFor({ role = "ADMIN", vertical = "travel", tenantId = 1 } = {}) {
  return jwt.sign({ userId: 7, tenantId, role, vertical }, JWT_SECRET, { expiresIn: "1h" });
}

beforeEach(() => {
  prisma.tenantSetting.findUnique.mockReset().mockResolvedValue(null);
  prisma.tenantSetting.upsert.mockReset().mockResolvedValue({ id: 31, key: travelSendGrid.CONFIG_KEY, updatedAt: new Date("2026-09-30T00:00:00Z") });
  prisma.tenantSetting.deleteMany.mockReset().mockResolvedValue({ count: 1 });
  prisma.auditLog.findFirst.mockReset().mockResolvedValue(null);
  prisma.auditLog.count.mockReset().mockResolvedValue(0);
  prisma.auditLog.create.mockReset().mockResolvedValue({ id: 1 });
  process.env.SENDGRID_API_KEY = "SG.backend.default";
  process.env.SENDGRID_FROM_EMAIL = "noreply@crm.test";
});

describe("Travel SendGrid BYOK settings", () => {
  test("rejects non-travel tenants and gives travel users a credential-free delivery summary", async () => {
    const generic = await request(makeApp()).get("/api/travel/email-provider").set("Authorization", `Bearer ${tokenFor({ vertical: "generic" })}`);
    expect(generic.status).toBe(403);
    const user = await request(makeApp()).get("/api/travel/email-provider").set("Authorization", `Bearer ${tokenFor({ role: "USER" })}`);
    expect(user.status).toBe(200);
    expect(user.body).toEqual({ configured: false, source: "backend" });
    expect(user.body).not.toHaveProperty("fallback");
    expect(user.body).not.toHaveProperty("apiKeyLast4");

    const update = await request(makeApp())
      .put("/api/travel/email-provider")
      .set("Authorization", `Bearer ${tokenFor({ role: "USER" })}`)
      .send({ apiKey: "SG.tenant.secret1234", fromEmail: "bookings@travel.test", fromName: "Acme Travel" });
    expect(update.status).toBe(403);
  });

  test("reports backend fallback without exposing its API key", async () => {
    const response = await request(makeApp()).get("/api/travel/email-provider").set("Authorization", `Bearer ${tokenFor()}`);
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      configured: false,
      source: "backend",
      fallback: { configured: true, fromEmail: "noreply@crm.test" },
    });
    expect(JSON.stringify(response.body)).not.toContain("SG.backend.default");
  });

  test("encrypts tenant credentials and only returns masked status", async () => {
    const response = await request(makeApp())
      .put("/api/travel/email-provider")
      .set("Authorization", `Bearer ${tokenFor()}`)
      .send({ apiKey: "SG.tenant.secret1234", fromEmail: "Bookings@Travel.Test", fromName: "Acme Travel" });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ configured: true, source: "tenant", fromEmail: "bookings@travel.test", fromName: "Acme Travel", apiKeyLast4: "****1234" });
    expect(response.body.apiKey).toBeUndefined();
    const write = prisma.tenantSetting.upsert.mock.calls[0][0];
    expect(write.create.value).toMatch(/^TRAVEL_MEETING_ENC:v1:/);
    expect(write.create.value).not.toContain("secret1234");
    expect(JSON.parse(decryptTravelMeetingCredential(write.create.value))).toEqual({
      apiKey: "SG.tenant.secret1234",
      fromEmail: "bookings@travel.test",
      fromName: "Acme Travel",
    });
  });

  test("rejects malformed credentials before writing", async () => {
    const response = await request(makeApp())
      .put("/api/travel/email-provider")
      .set("Authorization", `Bearer ${tokenFor()}`)
      .send({ apiKey: "wrong", fromEmail: "not-email", fromName: "Acme" });
    expect(response.status).toBe(400);
    expect(response.body.code).toBe("INVALID_SENDGRID_API_KEY");
    expect(prisma.tenantSetting.upsert).not.toHaveBeenCalled();
  });

  test("removes tenant credentials and reverts to backend fallback", async () => {
    const response = await request(makeApp()).delete("/api/travel/email-provider").set("Authorization", `Bearer ${tokenFor()}`);
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ configured: false, source: "backend", removed: true });
    expect(prisma.tenantSetting.deleteMany).toHaveBeenCalledWith({ where: { tenantId: 1, key: travelSendGrid.CONFIG_KEY } });
  });
});
