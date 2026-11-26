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
const previousJwtSecret = process.env.JWT_SECRET;
process.env.JWT_SECRET = previousJwtSecret || "test-generic-sendgrid-jwt-secret";
const router = requireCJS("../../routes/generic_email_provider");
const genericSendGrid = requireCJS("../../services/genericSendGrid");
const { decryptGenericSendGridCredential } = requireCJS("../../lib/genericSendGridCredentialEncryption");
const JWT_SECRET = process.env.JWT_SECRET || "enterprise_super_secret_key_2026";

afterAll(() => {
  if (previousJwtSecret === undefined) delete process.env.JWT_SECRET;
  else process.env.JWT_SECRET = previousJwtSecret;
});

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/generic/email-provider", router);
  return app;
}

function tokenFor({ role = "ADMIN", vertical = "generic", tenantId = 1 } = {}) {
  return jwt.sign({ userId: 7, tenantId, role, vertical }, JWT_SECRET, { expiresIn: "1h" });
}

beforeEach(() => {
  prisma.tenantSetting.findUnique.mockReset().mockResolvedValue(null);
  prisma.tenantSetting.upsert.mockReset().mockResolvedValue({ id: 41, key: genericSendGrid.CONFIG_KEY, updatedAt: new Date("2026-11-25T00:00:00Z") });
  prisma.tenantSetting.deleteMany.mockReset().mockResolvedValue({ count: 1 });
  prisma.auditLog.findFirst.mockReset().mockResolvedValue(null);
  prisma.auditLog.count.mockReset().mockResolvedValue(0);
  prisma.auditLog.create.mockReset().mockResolvedValue({ id: 1 });
  process.env.SENDGRID_API_KEY = "SG.backend.default";
  process.env.SENDGRID_FROM_EMAIL = "noreply@crm.test";
});

describe("Generic CRM SendGrid settings", () => {
  test.each(["travel", "wellness"])("rejects %s tenants", async (vertical) => {
    const response = await request(makeApp())
      .get("/api/generic/email-provider")
      .set("Authorization", `Bearer ${tokenFor({ vertical })}`);
    expect(response.status).toBe(403);
    expect(response.body.code).toBe("GENERIC_ONLY");
  });

  test("allows Generic admins and keeps the saved API key encrypted and masked", async () => {
    const response = await request(makeApp())
      .put("/api/generic/email-provider")
      .set("Authorization", `Bearer ${tokenFor()}`)
      .send({ apiKey: "SG.tenant.secret5678", fromEmail: "Sales@Generic.Test", fromName: "Acme Sales" });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      configured: true,
      source: "tenant",
      fromEmail: "sales@generic.test",
      fromName: "Acme Sales",
      apiKeyLast4: "****5678",
    });
    expect(response.body.apiKey).toBeUndefined();
    const write = prisma.tenantSetting.upsert.mock.calls[0][0];
    expect(write.create).toMatchObject({ tenantId: 1, key: "generic.email.sendgrid", category: "generic-email" });
    expect(write.create.value).toMatch(/^GENERIC_SENDGRID_ENC:v1:/);
    expect(write.create.value).not.toContain("secret5678");
    expect(JSON.parse(decryptGenericSendGridCredential(write.create.value))).toEqual({
      apiKey: "SG.tenant.secret5678",
      fromEmail: "sales@generic.test",
      fromName: "Acme Sales",
    });
  });

  test("does not allow a Generic non-admin to change credentials", async () => {
    const response = await request(makeApp())
      .put("/api/generic/email-provider")
      .set("Authorization", `Bearer ${tokenFor({ role: "USER" })}`)
      .send({ apiKey: "SG.tenant.secret5678", fromEmail: "sales@generic.test", fromName: "Acme Sales" });
    expect(response.status).toBe(403);
    expect(prisma.tenantSetting.upsert).not.toHaveBeenCalled();
  });

  test("removes only the Generic CRM tenant credential", async () => {
    const response = await request(makeApp())
      .delete("/api/generic/email-provider")
      .set("Authorization", `Bearer ${tokenFor()}`);
    expect(response.status).toBe(200);
    expect(prisma.tenantSetting.deleteMany).toHaveBeenCalledWith({
      where: { tenantId: 1, key: "generic.email.sendgrid" },
    });
  });
});
