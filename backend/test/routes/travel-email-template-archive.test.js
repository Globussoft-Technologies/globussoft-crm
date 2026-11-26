import { beforeEach, describe, expect, test, vi } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import { createRequire } from "node:module";
import prisma from "../../lib/prisma.js";

prisma.travelEmailTemplate = {
  findMany: vi.fn(),
  findFirst: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
  updateMany: vi.fn(),
  createMany: vi.fn(),
};
prisma.revokedToken = prisma.revokedToken || {};
prisma.revokedToken.findUnique = vi.fn().mockResolvedValue(null);
prisma.tenant = prisma.tenant || {};
prisma.tenant.findUnique = vi.fn().mockResolvedValue({ id: 2, vertical: "travel" });

const requireCJS = createRequire(import.meta.url);
const router = requireCJS("../../routes/travel_email_automation");
const JWT_SECRET = process.env.JWT_SECRET || "enterprise_super_secret_key_2026";

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/travel/email-automation", router);
  return app;
}

function token() {
  return jwt.sign({ userId: 7, tenantId: 2, role: "ADMIN", vertical: "travel" }, JWT_SECRET, { expiresIn: "1h" });
}

beforeEach(() => {
  prisma.travelEmailTemplate.findMany.mockReset().mockResolvedValue([]);
  prisma.travelEmailTemplate.findFirst.mockReset();
  prisma.travelEmailTemplate.update.mockReset();
  prisma.travelEmailTemplate.delete.mockReset();
  prisma.travelEmailTemplate.updateMany.mockReset().mockResolvedValue({ count: 0 });
  prisma.travelEmailTemplate.createMany.mockReset().mockResolvedValue({ count: 0 });
  prisma.revokedToken.findUnique.mockReset().mockResolvedValue(null);
  prisma.tenant.findUnique.mockReset().mockResolvedValue({ id: 2, vertical: "travel" });
});

describe("Travel email default-template archive", () => {
  test("DELETE archives and pauses a default template", async () => {
    prisma.travelEmailTemplate.findFirst.mockResolvedValueOnce({ id: 14, isDefault: true });
    prisma.travelEmailTemplate.update.mockResolvedValueOnce({ id: 14, isArchived: true, isActive: false });

    const response = await request(makeApp())
      .delete("/api/travel/email-automation/templates/14")
      .set("Authorization", `Bearer ${token()}`);

    expect(response.status).toBe(204);
    expect(prisma.travelEmailTemplate.update).toHaveBeenCalledWith({
      where: { id: 14 },
      data: { isArchived: true, isActive: false },
    });
    expect(prisma.travelEmailTemplate.delete).not.toHaveBeenCalled();
  });

  test("catalog moves an archived essential event into Optional", async () => {
    prisma.travelEmailTemplate.findMany.mockResolvedValueOnce([{ eventKey: "lead.created.welcome" }]);

    const response = await request(makeApp())
      .get("/api/travel/email-automation/catalog")
      .set("Authorization", `Bearer ${token()}`);

    expect(response.status).toBe(200);
    expect(response.body.essential.map((item) => item.value)).not.toContain("lead.created.welcome");
    expect(response.body.optional.map((item) => item.value)).toContain("lead.created.welcome");
  });
});
